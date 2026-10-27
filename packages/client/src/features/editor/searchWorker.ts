// The editor's search and replace, in a worker of its own (ARCHITECTURE.md §14.6). A user's
// regular expression can backtrack for minutes on the wrong text; here it can only stall
// this worker, which the page stops after a time limit.
import type { SearchRequest, SearchResponse } from "./search.ts"

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<SearchRequest>) => void) | null
  postMessage: (message: SearchResponse) => void
}

import { searchTexts } from "./searchCore.ts"

scope.onmessage = (event) => scope.postMessage(searchTexts(event.data))
