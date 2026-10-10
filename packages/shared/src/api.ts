// The client-facing contract. Every UI action is an RPC in this group (DESIGN §7.7).
import { Context, Schema } from "effect"
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc"
import { User } from "./domain.ts"

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {
  message: Schema.String
}) {}

/** The authenticated user, provided to every handler by the `Authentication` middleware. */
export class CurrentUser extends Context.Service<CurrentUser, User>()("rp/CurrentUser") {}

export class Authentication extends RpcMiddleware.Service<Authentication, { provides: CurrentUser }>()(
  "rp/Authentication",
  { error: Unauthorized }
) {}

export class Health extends Schema.Class<Health>("Health")({
  version: Schema.String,
  uptimeMs: Schema.Number,
  /** p99 event-loop delay on the server's main thread over the last sampling window. */
  eventLoopP99Ms: Schema.Number,
  readers: Schema.Int
}) {}

export class AppApi extends RpcGroup.make(
  Rpc.make("Health", { success: Health }),
  Rpc.make("Whoami", { success: User })
).middleware(Authentication) {}
