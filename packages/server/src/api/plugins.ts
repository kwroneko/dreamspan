import { CurrentUser } from "@rp/shared/api.ts"
import { PluginRejected, type PluginApi } from "@rp/shared/plugins.ts"
import { ServerError, StaleWrite } from "@rp/shared/errors.ts"
import { Effect } from "effect"
import { PluginHost } from "../plugins/Host.ts"
// Never log plugin-controlled failures: their text is untrusted and may contain credentials.
const boundary = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchCause((cause): Effect.Effect<never, PluginRejected | StaleWrite | ServerError> => {
      for (const reason of cause.reasons) {
        if (reason._tag === "Fail" && (reason.error instanceof PluginRejected || reason.error instanceof StaleWrite))
          return Effect.fail(reason.error)
      }
      return Effect.fail(new ServerError({ message: "Plugin operation failed" }))
    })
  )
export const makePluginHandlers = Effect.gen(function* () {
  const host = yield* PluginHost
  return {
    ListBuiltinParts: () => boundary(Effect.flatMap(CurrentUser, (user) => host.builtinParts(user))),
    CopyBuiltin: (input) => boundary(Effect.flatMap(CurrentUser, (user) => host.copyBuiltin(user, input))),
    ListPlugins: () => boundary(Effect.flatMap(CurrentUser, (user) => host.list(user))),
    GetPlugin: (target) => boundary(Effect.flatMap(CurrentUser, (user) => host.get(user, target))),
    CreatePlugin: (input) => boundary(Effect.flatMap(CurrentUser, (user) => host.create(user, input, input.files))),
    CommitPlugin: (input) =>
      boundary(Effect.flatMap(CurrentUser, (user) => host.commit(user, input, input.files, input.message))),
    PluginLog: (target) => boundary(Effect.flatMap(CurrentUser, (user) => host.log(user, target))),
    PluginDiff: (input) =>
      boundary(Effect.flatMap(CurrentUser, (user) => host.diff(user, input, input.before, input.after))),
    CheckPlugin: (target) => boundary(Effect.flatMap(CurrentUser, (user) => host.check(user, target))),
    EnablePlugin: (target) => boundary(Effect.flatMap(CurrentUser, (user) => host.enable(user, target))),
    PinPluginCommit: (target) => boundary(Effect.flatMap(CurrentUser, (user) => host.pin(user, target))),
    GoBackPlugin: (target) => boundary(Effect.flatMap(CurrentUser, (user) => host.goBack(user, target))),
    DisablePlugin: (target) => boundary(Effect.flatMap(CurrentUser, (user) => host.disable(user, target))),
    DeletePluginData: (target) => boundary(Effect.flatMap(CurrentUser, (user) => host.deleteData(user, target))),
    ListClientPlugins: () => boundary(Effect.flatMap(CurrentUser, (user) => host.clients(user)))
  } satisfies Parameters<typeof PluginApi.of>[0]
})
