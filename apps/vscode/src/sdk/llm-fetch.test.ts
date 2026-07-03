import type { Dispatcher, fetch as undiciFetch } from "undici"
import { EnvHttpProxyAgent, getGlobalDispatcher } from "undici"
import { describe, expect, it, vi } from "vitest"
import { createLlmFetch, getLlmDispatcher, LLM_BODY_TIMEOUT_MS, LLM_HEADERS_TIMEOUT_MS, llmFetch } from "./llm-fetch"

/** Undici's built-in default headersTimeout — the value that caused the bug. */
const UNDICI_DEFAULT_HEADERS_TIMEOUT_MS = 300_000

type FetchImpl = typeof undiciFetch

function makeFetchStub() {
	return vi.fn(async () => new Response("ok")) as unknown as FetchImpl
}

describe("llm-fetch timeouts", () => {
	it("raises the first-byte (headers) timeout past undici's 300s default", () => {
		expect(LLM_HEADERS_TIMEOUT_MS).toBe(900_000)
		expect(LLM_HEADERS_TIMEOUT_MS).toBeGreaterThan(UNDICI_DEFAULT_HEADERS_TIMEOUT_MS)
	})

	it("raises the body timeout past undici's 300s default", () => {
		expect(LLM_BODY_TIMEOUT_MS).toBe(900_000)
		expect(LLM_BODY_TIMEOUT_MS).toBeGreaterThan(UNDICI_DEFAULT_HEADERS_TIMEOUT_MS)
	})
})

describe("createLlmFetch", () => {
	it("passes the LLM dispatcher in the per-call init", async () => {
		const fetchStub = makeFetchStub()
		const dispatcher = { fake: "dispatcher" } as unknown as Dispatcher
		const doFetch = createLlmFetch({ fetchImpl: fetchStub, dispatcher })

		await doFetch("http://127.0.0.1:4000/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: '{"model":"hybrid-auto"}',
		})

		expect(fetchStub).toHaveBeenCalledTimes(1)
		const [input, init] = (fetchStub as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(input).toBe("http://127.0.0.1:4000/v1/chat/completions")
		expect(init.dispatcher).toBe(dispatcher)
		// Caller init is preserved alongside the injected dispatcher.
		expect(init.method).toBe("POST")
		expect(init.headers).toEqual({ "content-type": "application/json" })
		expect(init.body).toBe('{"model":"hybrid-auto"}')
	})

	it("defaults to the shared env-proxy-aware dispatcher with raised timeouts", async () => {
		const fetchStub = makeFetchStub()
		const doFetch = createLlmFetch({ fetchImpl: fetchStub })

		await doFetch("http://127.0.0.1:4000/v1/models")

		const [, init] = (fetchStub as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(init.dispatcher).toBeInstanceOf(EnvHttpProxyAgent)
		expect(init.dispatcher).toBe(getLlmDispatcher())
	})

	it("reuses one shared dispatcher across calls (module-level agent)", () => {
		expect(getLlmDispatcher()).toBe(getLlmDispatcher())
	})

	it("lets a caller-supplied init dispatcher win over the LLM dispatcher", async () => {
		const fetchStub = makeFetchStub()
		const doFetch = createLlmFetch({ fetchImpl: fetchStub })
		const callerDispatcher = { caller: "dispatcher" }

		await doFetch("http://127.0.0.1:4000/v1/models", {
			dispatcher: callerDispatcher,
		} as unknown as RequestInit)

		const [, init] = (fetchStub as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(init.dispatcher).toBe(callerDispatcher)
	})

	it("returns the delegate's response", async () => {
		const response = new Response("stream-bytes")
		const fetchStub = vi.fn(async () => response) as unknown as FetchImpl
		const doFetch = createLlmFetch({ fetchImpl: fetchStub })

		const result = await doFetch("http://127.0.0.1:4000/v1/chat/completions")

		expect(result).toBe(response)
	})
})

describe("isolation from other fetch users", () => {
	it("never touches the global dispatcher (extension host is shared)", async () => {
		const before = getGlobalDispatcher()

		// Both importing the module (already done above) and exercising the
		// fetch path must leave the process-wide dispatcher untouched.
		const fetchStub = makeFetchStub()
		await createLlmFetch({ fetchImpl: fetchStub })("http://127.0.0.1:4000/v1/models")
		getLlmDispatcher()

		expect(getGlobalDispatcher()).toBe(before)
		expect(getLlmDispatcher()).not.toBe(getGlobalDispatcher())
	})

	it("does not replace @/shared/net's exported fetch", async () => {
		const net = await import("@/shared/net")
		expect(net.fetch).not.toBe(llmFetch)
	})
})
