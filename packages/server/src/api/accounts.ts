// Account RPC handlers (DESIGN §10.1). Managing other users takes an admin; the rules
// themselves live in auth/Accounts.ts.
import { type AppApi, CurrentUser, Session } from "@rp/shared/api.ts"
import { AccountRejected, Forbidden } from "@rp/shared/errors.ts"
import { Effect } from "effect"
import { Accounts } from "../auth/Accounts.ts"

const admin = Effect.gen(function* () {
  const user = yield* CurrentUser
  if (user.role !== "admin") return yield* new Forbidden({ message: "only an admin can manage accounts" })
  return user
})

export const makeAccountHandlers = Effect.gen(function* () {
  const accounts = yield* Accounts
  return {
    // Resolved again from the same headers the middleware saw, to learn how, not just who.
    GetSession: (_, { headers }) => accounts.resolve(headers).pipe(Effect.map((session) => new Session(session))),
    ListUsers: () => admin.pipe(Effect.andThen(accounts.listUsers())),
    CreateUser: (input) => Effect.flatMap(admin, (actor) => accounts.createUser(actor, input)),
    SetPassword: (input) =>
      Effect.flatMap(CurrentUser, (actor) => accounts.setPassword(actor, input)).pipe(
        Effect.catchTag("LoginThrottled", () =>
          Effect.fail(new AccountRejected({ reason: "throttled", message: "too many wrong passwords; try later" }))
        )
      ),
    SetUserDisabled: ({ userId, disabled }) => admin.pipe(Effect.andThen(accounts.setDisabled(userId, disabled)))
  } satisfies Partial<Parameters<typeof AppApi.of>[0]>
})
