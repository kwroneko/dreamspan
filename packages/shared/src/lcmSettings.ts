import { Schema } from "effect"
import { ConnectionId, ModelId } from "./providers.ts"

/** A model of the user's, by its connection. */
export const ModelChoice = Schema.Struct({ connection: ConnectionId, model: ModelId })

export const LcmSettings = Schema.Struct({
  enabled: Schema.Boolean,
  tail: Schema.optionalKey(Schema.String),
  style: Schema.optionalKey(Schema.Literals(["direct", "tool"])),
  leafInput: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  leafTarget: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0)))
})
export const LcmDefaults = Schema.Struct({
  tail: Schema.optionalKey(Schema.String),
  spendAhead: Schema.optionalKey(Schema.Boolean),
  /** Tried once for a summary whose retries ran out on the summarizer's model. */
  fallback: Schema.optionalKey(ModelChoice)
})
