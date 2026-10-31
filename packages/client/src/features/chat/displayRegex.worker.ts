import { runDisplayRegex, type RegexJob } from "./displayRegex.ts"
self.onmessage = (event: MessageEvent<RegexJob>) => self.postMessage(runDisplayRegex(event.data))
// Loaded: the queue starts a job's deadline from here (displayWorker.ts).
self.postMessage("ready")
