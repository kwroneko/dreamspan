import { Cause, Effect, Layer, Logger } from "effect"

/**
 * A failure can carry incoming JSON, request URLs, provider bodies, or stored content.
 * The first log argument is a server-written event description with safe metadata.
 * Never render any other arguments or the Cause itself, even at debug level.
 */
export const serverLogs = Layer.effect(
  Logger.CurrentLoggers,
  Effect.map(
    Logger.CurrentLoggers,
    (loggers) =>
      new Set(
        [...loggers].map((logger) =>
          Logger.make((entry) => {
            const [event, ...details] = Array.isArray(entry.message) ? entry.message : [entry.message]
            const issue = Cause.hasDies(entry.cause)
              ? "defect"
              : Cause.hasFails(entry.cause) || details.length > 0
                ? "failure"
                : Cause.hasInterrupts(entry.cause)
                  ? "interrupted"
                  : undefined
            return logger.log({
              ...entry,
              message: [
                typeof event === "string" ? event : "Server operation failed",
                ...(issue === undefined ? [] : [issue])
              ],
              cause: Cause.empty
            })
          })
        )
      )
  )
)
