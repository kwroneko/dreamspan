// An upload's body, read from Node's request in two steps (ARCHITECTURE.md §11.4): wait for
// its first bytes, then read the rest. The route takes a memory permit between the two, so
// an upload that sends nothing holds none. Both steps give up after a pause between chunks
// and after an overall deadline, and stop at the size cap, without destroying the socket,
// so the route can still answer before the connection closes.
import type { IncomingMessage } from "node:http"
import { Effect, Schema } from "effect"

export class BodyRefused extends Schema.TaggedError<BodyRefused>()("BodyRefused", {
  reason: Schema.Literals(["too_large", "stalled", "too_slow", "aborted"])
}) {}

interface BodyLimits {
  readonly maxBytes: number
  /** The longest pause allowed between chunks, and before the first. */
  readonly idleMs: number
  /** When the whole body must have arrived, as a time from `Date.now()`. */
  readonly deadline: number
}

/**
 * Listens to `message` until `step` settles, with the pause and deadline timers. `step` gets
 * `done` to succeed with, and `reset` to call on each chunk.
 */
const listen = <A>(
  message: IncomingMessage,
  limits: BodyLimits,
  step: (done: (value: A) => void, fail: (reason: BodyRefused["reason"]) => void, reset: () => void) => () => void
) =>
  Effect.callback<A, BodyRefused>((resume) => {
    let idle: NodeJS.Timeout | undefined
    let stop = () => {}
    let settled = false
    const cleanUp = () => {
      clearTimeout(idle)
      clearTimeout(overall)
      stop()
      message.off("error", onAbort).off("close", onClose)
    }
    const finish = (effect: Effect.Effect<A, BodyRefused>) => {
      if (settled) return
      settled = true
      cleanUp()
      resume(effect)
    }
    const fail = (reason: BodyRefused["reason"]) => finish(Effect.fail(new BodyRefused({ reason })))
    const reset = () => {
      clearTimeout(idle)
      idle = setTimeout(() => fail("stalled"), limits.idleMs)
    }
    const onAbort = () => fail("aborted")
    const onClose = () => {
      if (!message.complete) fail("aborted")
    }
    const overall = setTimeout(() => fail("too_slow"), Math.max(0, limits.deadline - Date.now()))
    message.on("error", onAbort).on("close", onClose)
    reset()
    stop = step((value) => finish(Effect.succeed(value)), fail, reset)
    return Effect.sync(cleanUp)
  })

/** Resolves once the body's first bytes (or its end) have arrived, without reading them. */
export const firstBytes = (message: IncomingMessage, limits: BodyLimits) =>
  listen<void>(message, limits, (done) => {
    const ready = () => done()
    if (message.readableLength > 0 || message.readableEnded) {
      queueMicrotask(ready)
      return () => {}
    }
    message.once("readable", ready).once("end", ready)
    return () => message.off("readable", ready).off("end", ready)
  })

/** The whole body, at most `maxBytes`. On a refusal the request is paused, not destroyed. */
export const readBody = (message: IncomingMessage, limits: BodyLimits) =>
  listen<Uint8Array>(message, limits, (done, fail, reset) => {
    const chunks: Array<Buffer> = []
    let bytes = 0
    const onData = (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes > limits.maxBytes) return fail("too_large")
      chunks.push(chunk)
      reset()
    }
    const onEnd = () => done(Buffer.concat(chunks))
    message.on("data", onData).once("end", onEnd).resume()
    return () => {
      message.off("data", onData).off("end", onEnd)
      if (!message.readableEnded) message.pause()
    }
  })
