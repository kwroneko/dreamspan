import { Schema } from "effect"

export const LcmSettings = Schema.Struct({
  enabled: Schema.Boolean,
  tail: Schema.optionalKey(Schema.String),
  style: Schema.optionalKey(Schema.Literals(["direct", "tool"])),
  leafInput: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  leafTarget: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0)))
})
export const LcmDefaults = Schema.Struct({
  tail: Schema.optionalKey(Schema.String),
  spendAhead: Schema.optionalKey(Schema.Boolean)
})
