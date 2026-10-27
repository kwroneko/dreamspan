// Search and replace across an editor's fields (DESIGN §6.2), run in a worker that's stopped
// if it takes too long, so a catastrophic pattern can't hang the page.

export interface SearchRequest {
  readonly texts: ReadonlyArray<string>
  readonly find: string
  readonly regex: boolean
  readonly caseSensitive: boolean
  readonly wholeWord?: boolean
  readonly preserveCase?: boolean
  /** The replacement for every match, or null to only find. */
  readonly replace: string | null
  /** At most this many matches are listed. */
  readonly max: number
}

export type SearchResponse =
  | {
      readonly ok: true
      /** Each match: which text, where, how long. */
      readonly matches: ReadonlyArray<{
        readonly index: number
        readonly at: number
        readonly length: number
        readonly replacement: string | null
      }>
      readonly truncated: boolean
      /** Every text with its matches replaced, when a replacement was given. */
      readonly replaced: ReadonlyArray<string> | null
    }
  | { readonly ok: false; readonly error: string }

/** How long a search may run. Any real search of an editor's fields takes milliseconds. */
const TIME_LIMIT_MS = 2000

export const runSearch = (request: SearchRequest): Promise<SearchResponse> =>
  new Promise((resolve) => {
    const worker = new Worker(new URL("./searchWorker.ts", import.meta.url), { type: "module" })
    const done = (response: SearchResponse) => {
      clearTimeout(timer)
      worker.terminate()
      resolve(response)
    }
    const timer = setTimeout(
      () =>
        done({
          ok: false,
          error: `The search took over ${TIME_LIMIT_MS / 1000} seconds, so it was stopped. A pattern like (a+)+ can take forever on some texts: try a simpler one.`
        }),
      TIME_LIMIT_MS
    )
    worker.onmessage = (event: MessageEvent<SearchResponse>) => done(event.data)
    worker.onerror = () => done({ ok: false, error: "The search failed." })
    worker.postMessage(request)
  })
