import type { DisplayInput, DisplayResult } from "./displayPipeline.ts"
import type { RegexJob } from "./displayRegex.ts"
import { displayRegexApplies } from "./displayScripts.ts"

// A single queue bounds concurrent workers. One worker takes the jobs in turn, so a reply's
// text streaming through the scripts doesn't start a worker per frame; one that times out or
// fails is discarded, so a hostile preset cannot stall later messages or the UI. A job's
// deadline starts once its worker has loaded (it says "ready"), so a busy machine's slow worker
// start doesn't fail the job and show the text its scripts would change.

/** How long one job may run in a loaded worker, and how long a worker may take to load. */
const JOB_MS = 500
const STARTUP_MS = 10_000

/** A new worker, once it has loaded; null if it couldn't start or load in time. */
const startWorker = (): Promise<Worker | null> => {
  let worker: Worker
  try {
    worker = new Worker(new URL("./displayRegex.worker.ts", import.meta.url), { type: "module" })
  } catch {
    return Promise.resolve(null)
  }
  return new Promise((resolve) => {
    const done = (ready: boolean) => {
      clearTimeout(timer)
      worker.onmessage = null
      worker.onerror = null
      if (!ready) worker.terminate()
      resolve(ready ? worker : null)
    }
    const timer = setTimeout(() => done(false), STARTUP_MS)
    worker.onmessage = (event: MessageEvent<unknown>) => done(event.data === "ready")
    worker.onerror = () => done(false)
  })
}

let queue = Promise.resolve()
let pending = 0
let idle: Worker | null = null
export const regexDisplay = (input: DisplayInput): Promise<DisplayResult> | DisplayResult => {
  if (!input.prefs.displayRegex || input.scripts.length === 0) return { text: input.text, issues: [] }
  const placement = input.placement
  if (!displayRegexApplies(input.scripts, placement)) return { text: input.text, issues: [] }
  const scripts = input.scripts.filter(
    (s) => !s.disabled && s.find_regex !== "" && s.markdown_only && s.placement.includes(placement)
  )
  if (input.text.length > 200_000)
    return { text: input.text, issues: ["Display regex skipped: message exceeds 200,000 characters."] }
  return runRegexJob({
    text: input.text,
    scripts,
    placement,
    depth: input.depth,
    names: input.names,
    card: input.card
  })
}

/**
 * One job on the display-regex worker, in the one queue: within its deadline, or the text as
 * it was with a note. The script editors' "Try it" runs here too, never on the page's thread.
 */
export const runRegexJob = (job: RegexJob): Promise<DisplayResult> | DisplayResult => {
  if (pending >= 128)
    return {
      text: job.text,
      issues: ["Display regex skipped: too many messages are being processed. Original text shown."]
    }
  pending++
  const fallback = {
    text: job.text,
    issues: ["Display regex stopped: it took too long or couldn't run. Original text shown."]
  }
  const result = queue.then(async () => {
    const ready = idle ?? (await startWorker())
    idle = null
    if (ready === null) return fallback
    const worker = ready
    return new Promise<DisplayResult>((resolve) => {
      const done = (value: DisplayResult, keep: boolean) => {
        clearTimeout(timer)
        worker.onmessage = null
        worker.onerror = null
        if (keep && idle === null) idle = worker
        else worker.terminate()
        resolve(value)
      }
      const timer = setTimeout(() => done(fallback, false), JOB_MS)
      worker.onmessage = (event: MessageEvent<DisplayResult>) => done(event.data, true)
      worker.onerror = () => done(fallback, false)
      worker.postMessage(job)
    })
  })
  const settled = result.finally(() => {
    pending--
  })
  queue = settled.then(
    () => undefined,
    () => undefined
  )
  return settled
}
