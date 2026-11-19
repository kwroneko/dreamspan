// A sandbox's refusal to run a command, with a user-facing reason (as opposed to a failure).
// Its own module so sandboxes and the file tools can share it without an import cycle through
// registry.ts.

/** The command didn't start: `message` says why, for the tool result. */
export class CommandRefused extends Error {
  override readonly name = "CommandRefused"
}
