// Errors that cross to the client. Storage and provider failures keep their tags all
// the way to the UI, so the client can react to each (reload a stale form, ask for a key).
import { Schema } from "effect"

/** Missing, deleted, or someone else's: the three are indistinguishable on purpose. */
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  entity: Schema.String,
  id: Schema.String
}) {}

/** Optimistic concurrency: the row moved on since the caller read it (DATA-MODEL §10). */
export class StaleWrite extends Schema.TaggedError<StaleWrite>()("StaleWrite", {
  entity: Schema.String,
  id: Schema.String,
  expected: Schema.Int,
  actual: Schema.Int
}) {}

/** A model with this key already exists on the connection. */
export class ModelKeyTaken extends Schema.TaggedError<ModelKeyTaken>()("ModelKeyTaken", {
  connectionId: Schema.String,
  key: Schema.String
}) {}

/** The operation needs a role the user doesn't have. */
export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {
  message: Schema.String
}) {}

export const AccountRejectedReason = Schema.Literals([
  "handle_taken",
  "invalid_handle",
  "weak_password",
  "wrong_password",
  /** The last enabled admin can't be disabled: nobody could manage the instance. */
  "last_admin",
  /** An admin without a password of their own creates no accounts: they'd be locked out. */
  "own_password_first",
  "throttled",
  /** Accounts and passwords belong to the reverse proxy in proxy mode. */
  "proxy_mode"
])
export type AccountRejectedReason = typeof AccountRejectedReason.Type

/** An account change or login that can't be done as asked (DESIGN §10.1). */
export class AccountRejected extends Schema.TaggedError<AccountRejected>()("AccountRejected", {
  reason: AccountRejectedReason,
  message: Schema.String
}) {}

/** Something failed on the server that the client can't act on; details stay in the server log. */
export class ServerError extends Schema.TaggedError<ServerError>()("ServerError", {
  message: Schema.String
}) {}

export const ProviderErrorReason = Schema.Literals([
  /** The connection can't be used as configured: no key, an unreadable secret, a route the API can't take. */
  "unusable",
  "auth",
  "rate_limited",
  "overloaded",
  "context_overflow",
  "refused",
  "bad_request",
  "network",
  "aborted",
  "unknown"
])
export type ProviderErrorReason = typeof ProviderErrorReason.Type

/** A model request or connection check that failed (spec/PROVIDERS.md §7.1). */
export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", {
  reason: ProviderErrorReason,
  message: Schema.String,
  status: Schema.NullOr(Schema.Int),
  retryAfterMs: Schema.NullOr(Schema.Number),
  /** A refusal's category, where the provider gives one (Anthropic's stop_details). */
  category: Schema.NullOr(Schema.String),
  /** Whether the model had already produced output; such failures are never retried. */
  afterTokens: Schema.Boolean
}) {}
