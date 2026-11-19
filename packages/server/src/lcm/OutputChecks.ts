import type { ChatId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { Context, Effect, Layer } from "effect"
import { makeRegistry, type Registry } from "../registry.ts"
import type { ProviderError } from "@dreamspan/shared/errors.ts"
import type { JudgeUnavailable } from "../decision/RefusalJudge.ts"

/**
 * What a check made of an output. `refused` means the output must not be saved as a summary;
 * `JudgeUnavailable` means the check could not decide, which fails the attempt as well.
 */
type CheckVerdict = "accepted" | "refused"

export interface SummaryCheck {
  readonly id: string
  readonly check: (input: {
    readonly userId: UserId
    readonly chatId: ChatId
    readonly text: string
    readonly rolloutId: string
    /** The instruction the output answers. */
    readonly instruction?: string
  }) => Effect.Effect<CheckVerdict, JudgeUnavailable | ProviderError>
}

/**
 * Checks a summary's text must pass before it is saved. The refusal judge registers here; no
 * text heuristic participates in acceptance.
 */
export class SummaryChecks extends Context.Service<SummaryChecks, Registry<SummaryCheck>>()("rp/lcm/SummaryChecks") {
  static readonly layer = Layer.sync(SummaryChecks, () => makeRegistry<SummaryCheck>())
}
