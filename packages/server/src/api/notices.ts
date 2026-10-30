// The caller's notices (@rp/shared/noticeApi.ts): only their own replies and private draft updates.
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
          (queue) => Stream.concat(Stream.succeed([{ _tag: "UserDraftSync" as const }]), Stream.fromQueue(queue))
        )
      )
  } satisfies Partial<Parameters<typeof AppApi.of>[0]>
  return handlers
})
