// The System-One decision API as a provider kind (spec/AGENTIC.md §7; reference-harness
// `src/decisions/client.ts`): one endpoint takes `{ model, state, questions }` and returns typed
// answers. It isn't a chat API, so it never goes through pi-ai and writes no replies; the base URL
// is the endpoint itself, as reference-harness's `endpoint` is, so OpenRouter, TypeSafe's native route,
// a gateway or a self-hosted server are all just an address.
import { Effect } from "effect"
import type { ProviderStreams } from "@earendil-works/pi-ai"
import type { DecisionWire, ProviderKindEntry } from "./registry.ts"

/** Cap on the response body read: a decision response is a few KB. */
const MAX_RESPONSE_BYTES = 1_000_000

const readBody = async (body: Response["body"]): Promise<string | null> => {
  if (body === null) return ""
  const reader = body.getReader()
  const chunks: Array<Uint8Array> = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return new TextDecoder().decode(Buffer.concat(chunks, size))
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
}

const notChat = (): never => {
  throw new Error("This connection answers decision questions only; choose another connection for replies.")
}

/** Chat requests are refused before anything is sent (Providers.stream checks `decide`). */
const refusedStreams: ProviderStreams = { stream: notChat, streamSimple: notChat }

const systemOneWire: DecisionWire = {
  decide: async ({ baseUrl, apiKey, headers, fetch, body, signal }) => {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...headers
      },
      body: JSON.stringify(body),
      signal
    })
    const retryAfter = response.headers.get("retry-after")
    const seconds = retryAfter === null ? Number.NaN : Number(retryAfter)
    const text = await readBody(response.body)
    let parsed: unknown = null
    try {
      if (text !== null) parsed = JSON.parse(text) as unknown
    } catch {
      parsed = null
    }
    return {
      status: response.status,
      body: parsed,
      retryAfterMs: Number.isFinite(seconds) ? seconds * 1000 : null,
      ...(response.ok ? {} : { detail: text?.slice(0, 300) ?? "Decision response exceeded the byte limit." })
    }
  }
}

export const systemOneKind: ProviderKindEntry = {
  id: "system-one",
  label: "Decision model (System-One)",
  piProvider: "system-one",
  api: "system-one",
  streams: refusedStreams,
  acceptsFetch: true,
  defaultBaseUrl: "https://openrouter.ai/api/alpha/decisions",
  // A self-hosted server may take none; OpenRouter and TypeSafe refuse a request without one.
  keyOptional: true,
  // The endpoint has no model list: models are added by name (`typesafe/jev-1.13`).
  listModels: () => Effect.succeed([]),
  decide: systemOneWire
}
