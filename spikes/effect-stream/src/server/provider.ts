// A promise/async-iterator provider with an AbortSignal, shaped like pi-ai's
// streaming API. It knows nothing about Effect.

// aborted: the AbortSignal fired while the call was in flight.
// closed: the iterator was finalized (return() or completion), so nothing leaks.
export const providerStats = { started: 0, aborted: 0, completed: 0, closed: 0 }

const WORDS = (
  "the lantern swung low over the harbor while she counted the ships that had not come back " +
  "rain needled the slate roofs and somewhere below a bell rang twice then stopped " +
  "*he leans closer, voice dropping* you were never supposed to find that letter"
).split(" ")

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })

export async function* streamCompletion(
  options: { readonly tokens: number; readonly tokensPerSecond: number; readonly seed: number },
  signal: AbortSignal
): AsyncGenerator<string> {
  providerStats.started++
  const onAbort = () => providerStats.aborted++
  signal.addEventListener("abort", onAbort, { once: true })
  const interval = 1000 / options.tokensPerSecond
  try {
    for (let i = 0; i < options.tokens; i++) {
      await sleep(interval, signal)
      const word = WORDS[(options.seed * 7 + i) % WORDS.length]!
      yield (i > 0 && i % 40 === 0 ? "\n\n" : i === 0 ? "" : " ") + word
    }
    providerStats.completed++
  } catch (error) {
    if (signal.aborted) return
    throw error
  } finally {
    // The listener stays registered: Effect closes the iterator (return()) before
    // it releases the scope that aborts the signal, and we want to see both.
    providerStats.closed++
  }
}
