import type { DisplayInput, DisplayResult } from "./displayPipeline.ts"
import type { RegexJob } from "./displayRegex.ts"

// A single queue bounds concurrent workers. Each worker is discarded after one job,
// including timeouts, so a hostile preset cannot stall later messages or the UI.
let queue = Promise.resolve()
let pending = 0
export const regexDisplay = (input: DisplayInput): Promise<DisplayResult> | DisplayResult => {
  if (!input.prefs.displayRegex || input.scripts.length === 0) return { text: input.text, issues: [] }
  const placement = input.placement
  const scripts = input.scripts.filter(
    (s) => !s.disabled && s.find_regex !== "" && s.markdown_only && !s.prompt_only && s.placement.includes(placement)
  )
  if (scripts.length === 0) return { text: input.text, issues: [] }
  if (input.text.length > 200_000)
    return { text: input.text, issues: ["Display regex skipped: message exceeds 200,000 characters."] }
  if (pending >= 128)
    return {
      text: input.text,
      issues: ["Display regex skipped: too many messages are being processed. Original text shown."]
    }
  pending++
  const job: RegexJob = {
    text: input.text,
    scripts,
    placement,
    depth: input.depth,
    names: input.names,
    card: input.card
  }
  const result = queue.then(
    () =>
      new Promise<DisplayResult>((resolve) => {
        const fallback = {
          text: input.text,
          issues: ["Display regex stopped: time limit or worker unavailable. Original text shown."]
        }
        let worker: Worker
        try {
          worker = new Worker(new URL("./displayRegex.worker.ts", import.meta.url), { type: "module" })
        } catch {
          resolve(fallback)
          return
        }
        const done = (value: DisplayResult) => {
          clearTimeout(timer)
          worker.terminate()
          resolve(value)
        }
        const timer = setTimeout(() => done(fallback), 500)
        worker.onmessage = (event: MessageEvent<DisplayResult>) => done(event.data)
        worker.onerror = () => done(fallback)
        worker.postMessage(job)
      })
  )
  const settled = result.finally(() => {
    pending--
  })
  queue = settled.then(
    () => undefined,
    () => undefined
  )
  return settled
}
