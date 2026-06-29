import * as fs from "node:fs/promises"
import * as path from "node:path"
import { ActiveContextPack, LedgerEntry } from "./types"

export class ContextLedger {
	constructor(private readonly storageDir: string) {}

	private taskDir(taskId: string): string {
		return path.join(this.storageDir, taskId)
	}

	private entryPath(taskId: string, entry: LedgerEntry): string {
		// Filename sorts newest-last when lexicographically ordered.
		const timestamp = entry.timestamp.replace(/[:.]/g, "-")
		return path.join(this.taskDir(taskId), `entry-${timestamp}-${entry.id}.json`)
	}

	private packPath(taskId: string): string {
		return path.join(this.taskDir(taskId), "active-context-pack.json")
	}

	async appendEntry(entry: LedgerEntry): Promise<void> {
		const dir = this.taskDir(entry.taskId)
		await fs.mkdir(dir, { recursive: true })
		const filePath = this.entryPath(entry.taskId, entry)
		const tmpPath = `${filePath}.tmp`
		await fs.writeFile(tmpPath, JSON.stringify(entry, null, 2), "utf8")
		await fs.rename(tmpPath, filePath)
	}

	async getEntries(taskId: string): Promise<LedgerEntry[]> {
		const dir = this.taskDir(taskId)
		try {
			const files = await fs.readdir(dir)
			const entryFiles = files
				.filter((f) => f.startsWith("entry-") && f.endsWith(".json"))
				.sort()
				.reverse()
			const entries: LedgerEntry[] = []
			for (const file of entryFiles) {
				try {
					const raw = await fs.readFile(path.join(dir, file), "utf8")
					entries.push(JSON.parse(raw) as LedgerEntry)
				} catch {
					// Skip malformed entries.
				}
			}
			return entries
		} catch {
			return []
		}
	}

	async getActiveContextPack(taskId: string): Promise<ActiveContextPack | null> {
		const filePath = this.packPath(taskId)
		try {
			const raw = await fs.readFile(filePath, "utf8")
			return JSON.parse(raw) as ActiveContextPack
		} catch {
			return null
		}
	}

	async saveActiveContextPack(taskId: string, pack: ActiveContextPack): Promise<void> {
		const dir = this.taskDir(taskId)
		await fs.mkdir(dir, { recursive: true })
		const filePath = this.packPath(taskId)
		const tmpPath = `${filePath}.tmp`
		await fs.writeFile(tmpPath, JSON.stringify(pack, null, 2), "utf8")
		await fs.rename(tmpPath, filePath)
	}

	async pruneEntries(taskId: string, keepLast: number): Promise<number> {
		const dir = this.taskDir(taskId)
		try {
			const files = await fs.readdir(dir)
			const entryFiles = files.filter((f) => f.startsWith("entry-") && f.endsWith(".json")).sort()
			const toDelete = entryFiles.slice(0, Math.max(0, entryFiles.length - keepLast))
			for (const file of toDelete) {
				await fs.unlink(path.join(dir, file)).catch(() => {})
			}
			return toDelete.length
		} catch {
			return 0
		}
	}
}
