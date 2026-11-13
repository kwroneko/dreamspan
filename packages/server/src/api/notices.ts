import { ServerError } from "@rp/shared/errors.ts"
// The caller's notices: initial private-draft sync and durable plugin suspension reports.
import { type AppApi, CurrentUser } from "@rp/shared/api.ts"
import type { Notice } from "@rp/shared/noticeApi.ts"
import { Effect, Stream } from "effect"
import { Notices } from "../chat/Notices.ts"
import { Reader } from "../db/Database.ts"

export const makeNoticeHandlers = Effect.gen(function* () {
  const notices = yield* Notices
  const reader = yield* Reader
  return {
    SubscribeNotices: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const user = yield* CurrentUser
          const queue = yield* notices.subscribe(user.id)
          const initial: Array<Notice> = [{ _tag: "UserDraftSync" }]
          for (const owner of user.role === "admin" ? [user.id, ""] : [user.id]) {
            const pins = yield* reader.GetPluginPins({ userId: user.id, owner })
            for (const [id, pin] of Object.entries(pins.value))
              if (pin.suspended) initial.push({ _tag: "PluginsChanged", id, message: pin.suspended.reason })
          }
          return Stream.concat(Stream.succeed(initial), Stream.fromQueue(queue))
        }).pipe(Effect.catchCause(() => Effect.fail(new ServerError({ message: "Could not load notices" }))))
      )
  } satisfies Partial<Parameters<typeof AppApi.of>[0]>
})
