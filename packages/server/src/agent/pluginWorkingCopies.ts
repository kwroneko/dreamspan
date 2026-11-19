// Plugin working copies in the account's Files (spec/FILES-AND-ENVIRONMENT.md §5.3): each plugin
// repository the agent works on has a copy at /files/Plugins/<id> (an instance plugin's at
// /files/Plugins/Server/<id>, in the admin's Files) that commands and the file tools can change.
// The app's repository stays the authority: `plugin_commit from: "files"` reads the copy back, and
// after each change to the repository the copy is brought up to date. Registered, so the files
// feature (or a plugin) provides it; with none registered the plugin tools work as before.
import type { Effect } from "effect"
import type { User } from "@dreamspan/shared/domain.ts"

export interface PluginCopyTarget {
  readonly scope: "user" | "instance"
  readonly id: string
}

interface PluginCopySync {
  /** The copy's folder as the agent sees it. */
  readonly path: string
  /** Files of the copy that held changes the repository didn't have, overwritten; each is kept as a version. */
  readonly overwritten: ReadonlyArray<string>
}

export interface PluginWorkingCopy {
  readonly id: string
  /** Where the copy is, as the agent sees it. */
  readonly where: (target: PluginCopyTarget) => string
  /**
   * The copy's files as text (never its `.git` or `node_modules`), within the plugin limits;
   * fails with a user-facing message when they can't be a plugin's.
   */
  readonly read: (actor: User, target: PluginCopyTarget) => Effect.Effect<Record<string, string>, Error>
  /**
   * Makes the copy match the repository's tree `after`. `before` is the tree it had: a file of
   * the copy that differs from it was changed there and isn't in the repository, so its content
   * is kept as a version before it's replaced or removed. Files in neither tree stay as they are.
   */
  readonly sync: (input: {
    readonly actor: User
    readonly target: PluginCopyTarget
    readonly before: Readonly<Record<string, string>> | null
    readonly after: Readonly<Record<string, string>>
    /** The tool call this follows, for the kept versions' provenance. */
    readonly call?: { readonly rolloutId: string; readonly toolCallId: string }
  }) => Effect.Effect<PluginCopySync, Error>
}
