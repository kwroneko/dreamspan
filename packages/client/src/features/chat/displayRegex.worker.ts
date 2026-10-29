import { runDisplayRegex, type RegexJob } from "./displayRegex.ts"
self.onmessage = (event: MessageEvent<RegexJob>) => self.postMessage(runDisplayRegex(event.data))
