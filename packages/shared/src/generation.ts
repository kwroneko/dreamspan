import { LcmDefaults } from "./lcmSettings.ts"
// What a user's generations use when a chat doesn't choose (DATA-MODEL §5.4): a default
// model and a default preset, both the user's own.
import { Schema } from "effect"
import { RefId } from "./library.ts"
import { ConnectionId, ModelId } from "./providers.ts"

const ModelChoice = Schema.Struct({ connection: ConnectionId, model: ModelId })

export class GenerationDefaults extends Schema.Class<GenerationDefaults>("GenerationDefaults")({
  /** The model a chat without a `model.binding` generates with; none, and it can't generate. */
  model: Schema.NullOr(ModelChoice),
  lcm: Schema.optionalKey(LcmDefaults),
  /** The preset a chat without a `preset.binding` uses; none, and it's ST's default preset. */
  preset: Schema.NullOr(RefId)
}) {}
