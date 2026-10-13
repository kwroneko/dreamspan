import { LcmDefaults, ModelChoice } from "./lcmSettings.ts"
// What a user's generations use when a chat doesn't choose (DATA-MODEL §5.4): a default
// model and a default preset, both the user's own.
import { Schema } from "effect"
import { RefId } from "./library.ts"

export class GenerationDefaults extends Schema.Class<GenerationDefaults>("GenerationDefaults")({
  /** The model a chat without a `model.binding` generates with; none, and it can't generate. */
  model: Schema.NullOr(ModelChoice),
  lcm: Schema.optionalKey(LcmDefaults),
  /**
   * The decision model that judges soft refusals (spec/LCM.md §2.4); none, and only a
   * provider's own refusal signal is detected.
   */
  judge: Schema.optionalKey(Schema.NullOr(ModelChoice)),
  /** The preset a chat without a `preset.binding` uses; none, and it's ST's default preset. */
  preset: Schema.NullOr(RefId)
}) {}
