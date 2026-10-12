// The caller's notices (@rp/shared/noticeApi.ts): only ever their own, from any of their chats.
import { type AppApi, CurrentUser } from "@rp/shared/api.ts"
import { Effect, Stream } from "effect"
import { Notices } from "../chat/Notices.ts"

export const makeNoticeHandlers = Effect.gen(function* () {
  const notices = yield* Notices
  const handlers = {
    SubscribeNotices: () =>
      Stream.unwrap(
        Effect.map(
          Effect.flatMap(CurrentUser, (user) => notices.subscribe(user.id)),
          Stream.fromQueue
        )
      )
  } satisfies Partial<Parameters<typeof AppApi.of>[0]>
  return handlers
})
