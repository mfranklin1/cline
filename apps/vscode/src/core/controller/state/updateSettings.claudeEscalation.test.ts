import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Controller } from ".."
import { updateSettings } from "./updateSettings"

// Intercept the host-side keychain write (execFile("security", ...)).
const execFileMock = vi.hoisted(() => vi.fn((_cmd: string, _args: string[], cb: (error: Error | null) => void) => cb(null)))
vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("child_process")>()
	return { ...actual, execFile: execFileMock }
})

function makeController(existingHeaders: Record<string, string> = {}) {
	const globalState = new Map<string, unknown>()
	const controller = {
		task: undefined,
		postStateToWebview: vi.fn(async () => undefined),
		stateManager: {
			setGlobalState: vi.fn((key: string, value: unknown) => {
				globalState.set(key, value)
			}),
			getGlobalSettingsKey: vi.fn((key: string) => {
				if (key === "openAiHeaders") {
					return globalState.has("openAiHeaders") ? globalState.get("openAiHeaders") : existingHeaders
				}
				return globalState.get(key)
			}),
			setTaskSettings: vi.fn(),
		},
	}
	return {
		controller: controller as unknown as Controller,
		setGlobalState: controller.stateManager.setGlobalState,
		globalState,
	}
}

describe("updateSettings — claudeEscalationModel", () => {
	beforeEach(() => {
		execFileMock.mockClear()
	})

	it("stores the choice and writes the header through to openAiHeaders", async () => {
		const { controller, setGlobalState, globalState } = makeController({ "x-custom": "kept" })

		await updateSettings(controller, UpdateSettingsRequest.create({ claudeEscalationModel: "sonnet" }))

		expect(setGlobalState).toHaveBeenCalledWith("claudeEscalationModel", "sonnet")
		// Write-through preserves user-defined custom headers.
		expect(globalState.get("openAiHeaders")).toEqual({
			"x-custom": "kept",
			"x-claude-escalation-model": "sonnet",
		})
	})

	it("coerces unknown choices to haiku", async () => {
		const { controller, setGlobalState, globalState } = makeController()

		await updateSettings(controller, UpdateSettingsRequest.create({ claudeEscalationModel: "gpt-5" }))

		expect(setGlobalState).toHaveBeenCalledWith("claudeEscalationModel", "haiku")
		expect(globalState.get("openAiHeaders")).toEqual({ "x-claude-escalation-model": "haiku" })
	})

	it("accepts every valid tier", async () => {
		for (const choice of ["haiku", "sonnet", "opus", "fable"]) {
			const { controller, setGlobalState } = makeController()
			await updateSettings(controller, UpdateSettingsRequest.create({ claudeEscalationModel: choice }))
			expect(setGlobalState).toHaveBeenCalledWith("claudeEscalationModel", choice)
		}
	})
})

describe("updateSettings — anthropicEscalationApiKey (transient keychain write)", () => {
	// The keychain write is guarded by process.platform === "darwin". Force
	// darwin so the mocked `security` path is exercised on Linux/Windows CI
	// runners too (and the negative tests don't pass vacuously there).
	const realPlatform = process.platform

	beforeEach(() => {
		execFileMock.mockClear()
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true })
	})

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: realPlatform, configurable: true })
	})

	it("writes the key to the macOS keychain and never into state", async () => {
		const { controller, setGlobalState } = makeController()
		const plausibleKey = `sk-ant-${"x".repeat(100)}`

		await updateSettings(controller, UpdateSettingsRequest.create({ anthropicEscalationApiKey: plausibleKey }))

		expect(execFileMock).toHaveBeenCalledTimes(1)
		const [cmd, args] = execFileMock.mock.calls[0]
		expect(cmd).toBe("security")
		expect(args).toContain("add-generic-password")
		expect(args).toContain("anthropic-api-key")
		expect(args).toContain(plausibleKey)
		// The secret must NEVER land in extension state.
		for (const call of setGlobalState.mock.calls) {
			expect(JSON.stringify(call)).not.toContain(plausibleKey)
		}
	})

	it("refuses to overwrite the keychain with a value that is not an Anthropic key", async () => {
		// Regression: `security add-generic-password -U` overwrites in
		// place, so a short test string must never reach it.
		for (const bogus of ["test", "sk-ant-short", "x".repeat(60)]) {
			const { controller } = makeController()
			await updateSettings(controller, UpdateSettingsRequest.create({ anthropicEscalationApiKey: bogus }))
		}
		expect(execFileMock).not.toHaveBeenCalled()
	})

	it("ignores an empty key", async () => {
		const { controller } = makeController()

		await updateSettings(controller, UpdateSettingsRequest.create({ anthropicEscalationApiKey: "" }))

		expect(execFileMock).not.toHaveBeenCalled()
	})
})
