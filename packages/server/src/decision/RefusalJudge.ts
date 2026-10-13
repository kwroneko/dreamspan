// The decision model that reads an output and says whether it is a refusal (spec/LCM.md
// §2.4; DESIGN §7.6). Soft refusals are decided here and nowhere else: no pattern, phrase or
// length rule looks at the output. It is never mandatory: with no judge chosen, every output is
// "unjudged" and only a provider's own refusal signal (a hard refusal) is ever detected.
import type { ChatId, VersionId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Context, Effect, Layer, Stream } from "effect"
import { Reader } from "../db/Database.ts"
import { SummaryChecks } from "../lcm/OutputChecks.ts"
import { Providers } from "../providers/Providers.ts"

export type Verdict = "unjudged" | "clear" | "refused"

export interface JudgeInput {
  readonly userId: UserId
  readonly chatId: ChatId
  /** The output being judged. */
  readonly text: string
  /** What the output answers, where that helps: a summary's instruction. */
  readonly instruction?: string
  /** Attributes the judge's request to a rollout, so its cost lands in that rollout's usage. */
  readonly rolloutId?: string
  /** Attributes the judge's request to a version it is judging. */
  readonly versionId?: VersionId
}

/** A judge was chosen but gave no usable verdict: a failed request, a timeout, or an answer that isn't one. */
export class JudgeUnavailable {
  readonly _tag = "JudgeUnavailable"
  readonly message: string
  constructor(message: string) {
    this.message = message
  }
}

const SYSTEM =
  "You check whether text written by an AI model is a refusal. A refusal is a reply that declines, " +
  "deflects or breaks off the task it was given, instead of doing it: apologizing and not complying, " +
  "lecturing about why it won't, offering something else in place of the work, or stating it can't help. " +
  "Fiction that depicts a character refusing something is not a refusal. A faithful summary or " +
  "continuation of dark, violent or explicit material is not a refusal. " +
  "Answer with exactly one word: REFUSED or OK."

const JUDGE_TIMEOUT_MS = 60_000

export class RefusalJudge extends Context.Service<
  RefusalJudge,
  { readonly judge: (input: JudgeInput) => Effect.Effect<Verdict, JudgeUnavailable> }
>()("rp/decision/RefusalJudge") {
  static readonly layer = Layer.effect(
    RefusalJudge,
    Effect.gen(function* () {
      const reader = yield* Reader
      const providers = yield* Providers
      const checks = yield* SummaryChecks
      const judge = (input: JudgeInput): Effect.Effect<Verdict, JudgeUnavailable> =>
        Effect.gen(function* () {
          const defaults = yield* reader
            .GetGenerationDefaults({ userId: input.userId })
            .pipe(Effect.mapError((e) => new JudgeUnavailable(`The judge's settings can't be read: ${e.message}`)))
          const choice = defaults.judge
          if (!choice) return "unjudged" as const
          let answer = ""
          yield* providers
            .stream({
              userId: input.userId,
              connectionId: choice.connection,
              modelId: choice.model,
              context: {
                systemPrompt: SYSTEM,
                messages: [
                  {
                    role: "user",
                    content: [
                      {
                        type: "text",
                        text:
                          (input.instruction
                            ? `The task it was given:\n<task>\n${input.instruction}\n</task>\n\n`
                            : "") + `The text to check:\n<text>\n${input.text}\n</text>\n\nAnswer REFUSED or OK.`
                      }
                    ],
                    timestamp: 0
                  }
                ]
              },
              options: { maxTokens: 400, temperature: 0 },
              attribution: {
                purpose: "decision",
                chatId: input.chatId,
                rolloutId: input.rolloutId ?? null,
                versionId: input.versionId ?? null
              }
            })
            .pipe(
              Stream.runForEach((event) =>
                Effect.sync(() => {
                  if (event.type === "text") answer += event.delta
                })
              ),
              Effect.timeout(JUDGE_TIMEOUT_MS),
              Effect.mapError(
                (e) =>
                  new JudgeUnavailable(`The judge model failed: ${String((e as { message?: string }).message ?? e)}`)
              )
            )
          // The judge's own reply is a one-word protocol, not the judged text: nothing here reads the output.
          const word = answer
            .trim()
            .split(/\s+/)[0]
            ?.replace(/[^A-Za-z]/g, "")
            .toUpperCase()
          if (word === "REFUSED") return "refused" as const
          if (word === "OK") return "clear" as const
          return yield* Effect.fail(new JudgeUnavailable("The judge model gave no verdict."))
        })
      yield* checks.register({
        id: "refusal-judge",
        check: (input) =>
          judge({
            userId: input.userId,
            chatId: input.chatId,
            text: input.text,
            ...(input.instruction ? { instruction: input.instruction } : {}),
            rolloutId: input.rolloutId
          }).pipe(Effect.map((verdict) => (verdict === "refused" ? ("refused" as const) : ("accepted" as const))))
      })
      return RefusalJudge.of({ judge })
    })
  )
}
