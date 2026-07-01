import { JanitorMessage } from "./types"

const MAX_TOOL_RESULT_CHARS = 10_000
const NPM_INSTALL_KEEP_HEAD_LINES = 15
const NPM_INSTALL_KEEP_TAIL_LINES = 10
const TEST_OUTPUT_KEEP_HEAD = 200

// Detects npm/yarn/pip install commands in tool_result content.
function isInstallOutput(text: string): boolean {
	return /npm install|npm i |yarn install|yarn add|pip install/.test(text)
}

// Detects pytest/jest/mocha test runner output.
function isTestOutput(text: string): boolean {
	return /PASSED|FAILED|passed|failed|✓|✕|●|FAIL\b|PASS\b|Tests:\s+\d+/.test(text)
}

// Extracts the file path from common file-read tool result patterns.
function extractFileReadPath(text: string): string | null {
	const patterns = [
		/^Reading file:\s+(\S+)/m,
		/^File content of\s+(\S+):/m,
		/^Contents of\s+(\S+):/m,
		/^<file_content path="([^"]+)">/m,
	]
	for (const pat of patterns) {
		const m = pat.exec(text)
		if (m) return m[1]
	}
	return null
}

// Extract text from a content block, handling nested structures.
function extractText(
	content:
		| string
		| Array<{
				type: string
				text?: string
				content?: string | Array<{ type: string; text?: string }>
				[key: string]: unknown
		  }>
		| undefined,
): string {
	if (!content) return ""
	if (typeof content === "string") return content
	return content
		.map((block) => {
			if (block.type === "text" && typeof block.text === "string") return block.text
			if (block.type === "tool_result") {
				if (typeof block.content === "string") return block.content
				if (Array.isArray(block.content)) return extractText(block.content as Array<{ type: string; text?: string }>)
			}
			return ""
		})
		.join("")
}

// Truncate a tool_result text with a notice.
function truncateToolResult(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text
	const removed = text.length - maxChars
	return `${text.slice(0, maxChars)}\n[... ${removed} chars truncated by Headroom — full output archived]`
}

// Compress install output: keep first + last N lines.
function compressInstallOutput(text: string): string {
	const lines = text.split("\n")
	if (lines.length <= NPM_INSTALL_KEEP_HEAD_LINES + NPM_INSTALL_KEEP_TAIL_LINES + 1) return text
	const head = lines.slice(0, NPM_INSTALL_KEEP_HEAD_LINES).join("\n")
	const tail = lines.slice(-NPM_INSTALL_KEEP_TAIL_LINES).join("\n")
	const removedLines = lines.length - NPM_INSTALL_KEEP_HEAD_LINES - NPM_INSTALL_KEEP_TAIL_LINES
	return `${head}\n[... ${removedLines} lines of install output removed by Headroom ...]\n${tail}`
}

// Compress test output: keep FAIL lines + summary + head.
function compressTestOutput(text: string): string {
	const lines = text.split("\n")
	const failLines = lines.filter((l) => /FAIL|FAILED|●|✕|Error:|error:/.test(l))
	const summaryLine = lines.find((l) => /Tests?:\s+\d+|passed|failed|errors/.test(l)) ?? ""
	const head = text.slice(0, TEST_OUTPUT_KEEP_HEAD)
	const compressed = [...new Set([head, ...failLines, summaryLine].filter(Boolean))].join("\n")
	return compressed.length < text.length ? `${compressed}\n[test output compressed by Headroom]` : text
}

// Process a single tool_result text through compression rules.
function processToolResultText(text: string): string {
	if (isInstallOutput(text)) return compressInstallOutput(text)
	if (isTestOutput(text)) return compressTestOutput(text)
	return truncateToolResult(text, MAX_TOOL_RESULT_CHARS)
}

export class HeadroomAdapter {
	// Estimate tokens using char/3.6 heuristic (no tiktoken dependency).
	estimateTokens(messages: JanitorMessage[]): number {
		let chars = 0
		for (const msg of messages) {
			chars += extractText(msg.content as Parameters<typeof extractText>[0]).length
		}
		return Math.ceil(chars / 3.6)
	}

	// Compress messages by applying mechanical rules.
	// Returns a new array; does NOT mutate the input.
	compress(messages: JanitorMessage[]): JanitorMessage[] {
		// First pass: collect all file-read paths with their last-seen message index.
		const lastFileReadIndex = new Map<string, number>()
		for (let i = 0; i < messages.length; i++) {
			const text = extractText(messages[i].content as Parameters<typeof extractText>[0])
			const fp = extractFileReadPath(text)
			if (fp) lastFileReadIndex.set(fp, i)
		}

		const result: JanitorMessage[] = []

		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i]
			const content = msg.content

			if (typeof content === "string") {
				// Plain string messages — check for file-read dedup.
				const fp = extractFileReadPath(content)
				if (fp && lastFileReadIndex.get(fp) !== i) {
					result.push({ ...msg, content: "[File read deduplicated by Headroom — superseded by later read]" })
				} else {
					result.push({ ...msg, content: processToolResultText(content) })
				}
				continue
			}

			if (!Array.isArray(content)) {
				result.push(msg)
				continue
			}

			// Content block array: process each block.
			const newBlocks = content.map((block) => {
				if (block.type !== "tool_result") return block

				const rawText =
					typeof block.content === "string"
						? block.content
						: extractText(block.content as Parameters<typeof extractText>[0])

				const fp = extractFileReadPath(rawText)
				if (fp && lastFileReadIndex.get(fp) !== i) {
					return { ...block, content: "[File read deduplicated by Headroom — superseded by later read]" }
				}

				const compressed = processToolResultText(rawText)
				if (typeof block.content === "string") {
					return { ...block, content: compressed }
				}
				return { ...block, content: [{ type: "text", text: compressed }] }
			})

			result.push({ ...msg, content: newBlocks })
		}

		return result
	}
}
