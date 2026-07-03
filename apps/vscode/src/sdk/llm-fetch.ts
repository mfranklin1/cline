/**
 * LLM-scoped `fetch` with raised undici first-byte and body timeouts.
 *
 * ## Why this exists
 *
 * In the VS Code extension host, `@/shared/net`'s fetch resolves to Node's
 * global fetch, which is undici with its default `headersTimeout` of
 * 300_000 ms (5 minutes). A local model behind a streaming proxy (e.g.
 * LiteLLM in front of Ollama/MLX) sends NO response headers until the first
 * token is produced — i.e. until prompt prefill completes. Measured cold
 * prefill of a ~130K-token prompt on the local 80B is ~8-11 minutes, so
 * undici silently aborts at exactly 300s, Cline surfaces "Model returned
 * empty response" and auto-retries, and the abandoned request keeps grinding
 * the GPU. `headersTimeout` must therefore exceed worst-case prefill; the
 * proxy's own `request_timeout` remains the authoritative kill switch for a
 * genuinely hung upstream.
 *
 * ## Scope
 *
 * This fetch is used ONLY for LLM provider traffic (the session
 * `providerConfig.fetch` built in `cline-session-factory.ts` and the
 * standalone handler config in `sdk-api-handler.ts`). All other extension
 * HTTP keeps going through `@/shared/net` with default timeouts.
 *
 * This module never calls `setGlobalDispatcher`: the extension host is
 * shared with other extensions and VS Code's own proxy plumbing, so the
 * raised timeouts ride on a per-call `dispatcher` instead. Proxy support is
 * preserved via `EnvHttpProxyAgent`, which honors the standard
 * `http_proxy` / `https_proxy` / `no_proxy` environment variables (the same
 * mechanism the standalone builds use — see `@/shared/net`).
 */

import type { Dispatcher } from "undici"
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici"

/**
 * Max time to wait for response HEADERS (undici `headersTimeout`).
 * Headers only arrive after the model's prompt prefill completes, so this
 * must exceed worst-case cold prefill (~8-11 min measured on the local 80B
 * with a ~130K-token prompt). Undici's default is 300_000 ms.
 */
export const LLM_HEADERS_TIMEOUT_MS = 900_000

/**
 * Max idle time between BODY chunks (undici `bodyTimeout`). Raised alongside
 * `headersTimeout` so a long generation pause (e.g. proxy-side buffering or a
 * reasoning model between phases) doesn't kill an in-flight stream.
 */
export const LLM_BODY_TIMEOUT_MS = 900_000

type UndiciFetchInput = Parameters<typeof undiciFetch>[0]
type UndiciFetchInit = Parameters<typeof undiciFetch>[1]

let sharedLlmDispatcher: EnvHttpProxyAgent | undefined

/**
 * Lazily-created, module-level dispatcher shared by all LLM fetch calls.
 * Env-proxy-aware, with first-byte/body timeouts raised for slow prefill.
 */
export function getLlmDispatcher(): Dispatcher {
	sharedLlmDispatcher ??= new EnvHttpProxyAgent({
		headersTimeout: LLM_HEADERS_TIMEOUT_MS,
		bodyTimeout: LLM_BODY_TIMEOUT_MS,
	})
	return sharedLlmDispatcher
}

export interface CreateLlmFetchOptions {
	/** Fetch implementation to delegate to (default: undici's fetch). For tests. */
	fetchImpl?: typeof undiciFetch
	/** Dispatcher to attach to each call (default: the shared LLM dispatcher). For tests. */
	dispatcher?: Dispatcher
}

/**
 * Build a `fetch` that delegates to undici's fetch with the LLM dispatcher
 * attached as a per-call `init.dispatcher`. A dispatcher already present on
 * the caller's `init` wins, so explicit per-request overrides stay possible.
 */
export function createLlmFetch(options?: CreateLlmFetchOptions): typeof globalThis.fetch {
	const fetchImpl = options?.fetchImpl ?? undiciFetch
	const llmFetchImpl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const callerDispatcher = (init as { dispatcher?: Dispatcher } | undefined)?.dispatcher
		const undiciInit = {
			...(init as UndiciFetchInit),
			dispatcher: callerDispatcher ?? options?.dispatcher ?? getLlmDispatcher(),
		} as UndiciFetchInit
		return fetchImpl(input as UndiciFetchInput, undiciInit) as unknown as Promise<Response>
	}
	return llmFetchImpl as typeof globalThis.fetch
}

/**
 * The LLM provider fetch: env-proxy-aware, 15-minute first-byte allowance.
 * Pass this as `ProviderConfig.fetch` for LLM traffic only — never use it for
 * general extension HTTP (use `@/shared/net` for that).
 */
export const llmFetch: typeof globalThis.fetch = createLlmFetch()
