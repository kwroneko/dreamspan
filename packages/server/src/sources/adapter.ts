// The card-source adapter (spec/CARD-SOURCES.md §2.2): what knows how to talk to one archive.
// Adapters never fetch on their own: every request goes through the `SourceHttp` they're
// given, which keeps them on their declared hosts, under the response caps and timeouts, and
// behind the source's rate limit (guard.ts, limiter.ts).
import type {
  RemoteCreator,
  RemoteRelative,
  RemoteSummary,
  SourceCapabilities,
  SourceFailed,
  SourceQuery,
  SourceTag,
  SourceSuggestions
} from "@rp/shared/cardSources.ts"
import type { Effect } from "effect"

/** A response, read whole under its cap. */
export interface SourceResponse {
  readonly status: number
  readonly headers: Headers
  readonly bytes: Uint8Array
  readonly json: () => unknown
}

/** What a request may read: JSON is capped at 2 MiB, card files at 64 MiB, images at 16 MiB (§6.2). */
export type ResponseKind = "json" | "card" | "image"

export interface SourceHttp {
  /**
   * A GET on one of the adapter's hosts. Conditional requests may return 304 without a
   * body; other non-2xx statuses fail: 401/403 `unauthorized` (for a source with no key,
   * `refused`), 404 `not_found`, 451 `region_unavailable`, 429 or 503 with Retry-After `rate_limited`
   * (with its Retry-After and status), other 5xx `unreachable` (with status), any other
   * (a 400 among them) `bad_response`, with the error code a refusal's body named.
   */
  readonly get: (
    url: URL,
    kind: ResponseKind,
    headers?: Readonly<Record<string, string>>
  ) => Effect.Effect<SourceResponse, SourceFailed>
  /** The user's API key for this source, when one is set. */
  readonly apiKey: string | null
}

/** An adapter's summary: as the client's, but `thumb` and `image` are the adapter's own references. */
export type AdapterSummary = RemoteSummary

/** A card as a file: PNG (`chara`/`ccv3`), CHARX or V2/V3 JSON, as the archive gave it. */
interface RemoteCardFile {
  readonly bytes: Uint8Array
  readonly fileName: string
  readonly summary: AdapterSummary
}

interface AdapterPage {
  /** The source restarted from the first page after refusing a cursor. */
  readonly reset?: boolean
  readonly notice?: string
  readonly items: ReadonlyArray<AdapterSummary>
  readonly next: string | null
  readonly totalCapped?: boolean
  readonly total?: number
  readonly totalEstimated?: boolean
}

export interface CardSourceAdapter {
  /** "cardex": namespaced in URLs and keys. */
  readonly id: string
  /** "cardex": the Show option's label (owner, 2026-11-06). */
  readonly name: string
  /** The only hosts it may contact (§6.2), as `host` or `host:port`. */
  readonly hosts: ReadonlyArray<string>
  /** The scheme it uses on them; `http` only for a source on this machine (`local`). */
  readonly scheme?: "https" | "http"
  /**
   * The hosts are on this machine or the local network, as a development source's are.
   * Otherwise a host resolving to a private or loopback address is refused unless the admin
   * listed it by name on the network bypass list (§6.2).
   */
  readonly local?: boolean
  /** Whether the API takes a key. */
  readonly key?: "none" | "optional" | "required"
  /** The archive's documented rate; 2 requests/s with a burst of 8 when unset (§5.5). */
  readonly rate?: { readonly perSecond: number; readonly burst: number }
  readonly capabilities: (http: SourceHttp) => Effect.Effect<SourceCapabilities, SourceFailed>
  readonly search: (
    http: SourceHttp,
    query: SourceQuery,
    page: string | null
  ) => Effect.Effect<AdapterPage, SourceFailed>
  readonly tags?: (
    http: SourceHttp,
    prefix: string
  ) => Effect.Effect<ReadonlyArray<typeof SourceTag.Type>, SourceFailed>
  readonly suggestions?: (
    http: SourceHttp,
    kind: "tags" | "creators",
    prefix: string,
    page: string | null
  ) => Effect.Effect<SourceSuggestions, SourceFailed>
  readonly card: (http: SourceHttp, remoteId: string) => Effect.Effect<RemoteCardFile, SourceFailed>
  /** An image a summary referenced (`thumb` or `image`), as bytes. */
  readonly image: (http: SourceHttp, ref: string) => Effect.Effect<Uint8Array, SourceFailed>
  /** A creator's public profile, by the creator filter's value; `avatar` is the adapter's own reference. */
  readonly creator?: (http: SourceHttp, query: string) => Effect.Effect<RemoteCreator, SourceFailed>
  /**
   * A card's family: what it was forked from or listed as before, its versions and its forks,
   * a bounded number; `thumb` is the adapter's own reference, `held` unset.
   */
  readonly family?: (
    http: SourceHttp,
    remoteId: string
  ) => Effect.Effect<{ readonly items: ReadonlyArray<RemoteRelative>; readonly more: boolean }, SourceFailed>
  /**
   * The source's cards a card names among its links (its `source` entries, its extensions'
   * page URLs): their remote ids. Pure and quick: it runs on the main thread for each import.
   */
  readonly recognize?: (links: ReadonlyArray<string>) => ReadonlyArray<string>
  /** Current versions for many ids at once, for update checks (phase 5). */
  readonly versions?: (
    http: SourceHttp,
    ids: ReadonlyArray<string>
  ) => Effect.Effect<
    ReadonlyArray<{ readonly remoteId: string; readonly version: AdapterSummary["version"] }>,
    SourceFailed
  >
}
