import { Cause, Exit, Runtime } from "effect"

let restartCode: number | undefined

export const requestRestart = (code: number) => {
  restartCode = code
  // Run the same HTTP drain and worker finalizers as a normal stop, on Windows too.
  process.emit("SIGTERM", "SIGTERM")
}

export const teardown: Runtime.Teardown = (exit, onExit) =>
  Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
    ? onExit(restartCode ?? 0)
    : Runtime.defaultTeardown(exit, onExit)
