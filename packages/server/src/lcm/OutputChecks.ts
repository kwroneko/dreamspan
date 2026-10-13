import type { UserId } from "@rp/shared/domain.ts"
import { Context, Effect, Layer } from "effect"
import { makeRegistry, type Registry } from "../registry.ts"

interface SummaryCheck {
  readonly id: string
  readonly check: (input: {
    readonly userId: UserId
    readonly text: string
    readonly rolloutId: string
  }) => Effect.Effect<boolean>
}
/** Slice 4 registers the judge here. No text heuristics participate in acceptance. */
export class SummaryChecks extends Context.Service<SummaryChecks, Registry<SummaryCheck>>()("rp/lcm/SummaryChecks") {
  static readonly layer = Layer.sync(SummaryChecks, () => makeRegistry<SummaryCheck>())
}
