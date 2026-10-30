// Greeting policy is shared by the pending preview and the two server stages. Plugins
// can override or disable sources through the same scoped registry as other features.
import { Effect, Scope } from "effect"
import { makeRegistry } from "./registry.ts"

interface GreetingCard {
  readonly greetings: ReadonlyArray<string>
  readonly groupGreetings: ReadonlyArray<string>
}
interface GreetingOption {
  readonly text: string
  /** Index in the card's nonempty ordinary + group-only greetings. */
  readonly index: number
  readonly groupOnly: boolean
}
export const greetingSources = makeRegistry<{
  readonly id: string
  readonly offer: (card: GreetingCard, characterCount: number) => ReadonlyArray<GreetingOption>
}>()

Effect.runSync(
  Effect.flatMap(Scope.make(), (scope) =>
    Scope.provide(scope)(
      Effect.all([
        greetingSources.register({
          id: "greetings.ordinary",
          offer: (card) => card.greetings.map((text, index) => ({ text, index, groupOnly: false }))
        }),
        greetingSources.register({
          id: "greetings.group-only",
          offer: (card, count) =>
            count > 1
              ? card.groupGreetings.map((text, index) => ({
                  text,
                  index: card.greetings.length + index,
                  groupOnly: true
                }))
              : []
        })
      ])
    )
  )
)

export const offeredGreetings = (card: GreetingCard, characterCount: number) =>
  greetingSources.list().flatMap((source) => source.offer(card, characterCount))

/** A removed group choice falls back to the first greeting, never a hidden choice. */
export const greetingPick = (options: ReadonlyArray<GreetingOption>, picked: number | null) =>
  options.find((option) => option.index === picked) ?? options[0]
