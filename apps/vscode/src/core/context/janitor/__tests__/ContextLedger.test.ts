import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { expect } from "chai"
import { ContextLedger } from "../ContextLedger"
import { ActiveContextPack, LedgerEntry } from "../types"

function makeEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
	return {
		id: `test-${Math.random().toString(36).slice(2)}`,
		taskId: "task-123",
		timestamp: new Date().toISOString(),
		rawTokens: 1000,
		curatedTokens: 700,
		messagesProcessed: 10,
		decisions: [],
		backendSwitchAvoided: false,
		...overrides,
	}
}

function makePack(): ActiveContextPack {
	return {
		taskGoal: "fix the login bug",
		keyConstraints: ["never use global fetch"],
		activeErrors: ["TypeError: cannot read property"],
		activeDiffs: ["--- a/src/auth.ts"],
		openTasks: ["verify the fix"],
		recentDecisions: ["use HostProvider for fetch"],
		lastUpdated: new Date().toISOString(),
	}
}

describe("ContextLedger", () => {
	let tmpDir: string
	let ledger: ContextLedger

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "janitor-ledger-test-"))
		ledger = new ContextLedger(tmpDir)
	})

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true })
	})

	describe("appendEntry / getEntries", () => {
		it("returns the appended entry", async () => {
			const entry = makeEntry({ taskId: "task-abc" })
			await ledger.appendEntry(entry)
			const entries = await ledger.getEntries("task-abc")
			expect(entries).to.have.length(1)
			expect(entries[0].id).to.equal(entry.id)
		})

		it("returns multiple entries newest-first", async () => {
			const e1 = makeEntry({ taskId: "t1", id: "first", timestamp: "2025-01-01T00:00:00.000Z" })
			const e2 = makeEntry({ taskId: "t1", id: "second", timestamp: "2025-06-01T00:00:00.000Z" })
			await ledger.appendEntry(e1)
			await ledger.appendEntry(e2)
			const entries = await ledger.getEntries("t1")
			expect(entries).to.have.length(2)
			expect(entries[0].id).to.equal("second")
		})

		it("returns empty array for unknown taskId", async () => {
			const entries = await ledger.getEntries("nonexistent-task")
			expect(entries).to.deep.equal([])
		})
	})

	describe("saveActiveContextPack / getActiveContextPack", () => {
		it("saves and retrieves the context pack", async () => {
			const pack = makePack()
			await ledger.saveActiveContextPack("task-xyz", pack)
			const retrieved = await ledger.getActiveContextPack("task-xyz")
			expect(retrieved).to.not.be.null
			expect(retrieved!.taskGoal).to.equal("fix the login bug")
			expect(retrieved!.activeErrors).to.deep.equal(["TypeError: cannot read property"])
		})

		it("returns null when no pack saved", async () => {
			const result = await ledger.getActiveContextPack("no-such-task")
			expect(result).to.be.null
		})
	})

	describe("pruneEntries", () => {
		it("removes old entries beyond keepLast", async () => {
			for (let i = 0; i < 5; i++) {
				await ledger.appendEntry(
					makeEntry({ taskId: "prune-task", id: `e${i}`, timestamp: `2025-0${i + 1}-01T00:00:00.000Z` }),
				)
			}
			const removed = await ledger.pruneEntries("prune-task", 2)
			expect(removed).to.equal(3)
			const entries = await ledger.getEntries("prune-task")
			expect(entries).to.have.length(2)
		})

		it("returns 0 when entries are within keepLast", async () => {
			await ledger.appendEntry(makeEntry({ taskId: "small-task" }))
			const removed = await ledger.pruneEntries("small-task", 10)
			expect(removed).to.equal(0)
		})
	})
})
