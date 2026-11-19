// Conditional upstream reads share the existing bounded, per-user disk cache. Parsed
// pages/cards keep their normal lifetimes; validators outlive them so a refresh can use 304.
import { createHash } from "node:crypto"
import { SourceFailed } from "@dreamspan/shared/cardSources.ts"
import { Effect, Exit } from "effect"
import type { SourceHttp, SourceResponse } from "./adapter.ts"
import type { SourceCache } from "./cache.ts"

interface ValidatedResponse {
  readonly headers: ReadonlyArray<readonly [string, string]>
  readonly etag: string
}

export const withConditionalGets = (
  http: SourceHttp,
  cache: SourceCache,
  user: string,
  source: string
): SourceHttp => ({
  apiKey: http.apiKey,
  get: (url, kind, headers = {}) =>
    Effect.gen(function* () {
      // Credentials and custom request headers can select a different representation.
      const id = createHash("sha256")
        .update(JSON.stringify([url.href, kind, http.apiKey, Object.entries(headers).sort()]))
        .digest("hex")
      const key = { user, source, kind: "response" as const, id }
      const hit = yield* cache.get(key)
      // Own the old bytes before waiting on the network: another request can clear or
      // evict the entry while its conditional GET is in flight.
      const stored = hit?.blob ? yield* Effect.exit(cache.readBlob(hit.blob)) : null
      const bytes = stored && Exit.isSuccess(stored) ? stored.value : null
      const previous = bytes !== null ? (hit!.value as ValidatedResponse) : undefined
      const response = yield* http.get(url, kind, {
        ...headers,
        ...(previous ? { "if-none-match": previous.etag } : {})
      })
      if (response.status === 304) {
        if (bytes === null || !previous)
          return yield* new SourceFailed({
            sourceId: source,
            reason: "bad_response",
            message: "unexpected cache validation"
          })
        const merged = new Headers(Object.fromEntries(previous.headers))
        for (const [name, value] of response.headers) merged.set(name, value)
        return {
          status: 200,
          headers: merged,
          bytes,
          json: () => JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown
        } satisfies SourceResponse
      }
      const etag = response.headers.get("etag")
      if (etag && !/\bno-store\b/i.test(response.headers.get("cache-control") ?? "")) {
        yield* cache.put(key, {
          bytes: response.bytes,
          value: { etag, headers: [...response.headers] } satisfies ValidatedResponse
        })
      } else if (hit) yield* cache.remove(key)
      return response
    })
})
