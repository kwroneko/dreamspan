import type { DisplayInput, DisplayResult } from "./displayPipeline.ts"
import type { RegexJob } from "./displayRegex.ts"
import { displayRegexApplies } from "./displayScripts.ts"

// A single queue bounds concurrent workers. One worker takes the jobs in turn, so a reply's
// text streaming through the scripts doesn't start a worker per frame; one that times out or
// fails is discarded, so a hostile preset cannot stall later messages or the UI.
let queue = Promise.resolve()
let pending = 0
let idle: Worker | null = null
export const regexDisplay = (input: DisplayInput): Promise<DisplayResult> | DisplayResult => {
  if (!input.prefs.displayRegex || input.scripts.length === 0) return { text: input.text, issues: [] }
  const placement = input.placement
  if (!displayRegexApplies(input.scripts, placement)) return { text: input.text, issues: [] }
  const scripts = input.scripts.filter(
    (s) => !s.disabled && s.find_regex !== "" && s.markdown_only && !s.prompt_only && s.placement.includes(placement)
  )
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
          worker = idle ?? new Worker(new URL("./displayRegex.worker.ts", import.meta.url), { type: "module" })
        } catch {
          resolve(fallback)
          return
        }
        idle = null
        const done = (value: DisplayResult, keep: boolean) => {
          clearTimeout(timer)
          worker.onmessage = null
          worker.onerror = null
          if (keep && idle === null) idle = worker
          else worker.terminate()
          resolve(value)
        }
        const timer = setTimeout(() => done(fallback, false), 500)
        worker.onmessage = (event: MessageEvent<DisplayResult>) => done(event.data, true)
        worker.onerror = () => done(fallback, false)
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
