// Planning a run's tool loading (spec/TOOL-LOADING.md §3): reads the workshop cards' skills at the
// revisions the assembly used, then splits the offer through the registered profile and wire.
import type { RefId, RevisionId } from "@rp/shared/library.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import type { ModelInput } from "../assembler/types.ts"
import type { Reader } from "../db/Database.ts"
import type { ExecutionRegistry } from "../execution.ts"
import {
  cardSkills as readCardSkills,
  loadSkillDescription,
  LOADERS,
  orphansOf,
  runSkills,
  type Skill,
  skillsFor,
  splitOffer,
  TOOL_SEARCH,
  LOAD_SKILL,
  toolSearchDescription,
  type ToolOffer
} from "./toolLoading.ts"
import type { FrozenTool, RolloutTool } from "./tools.ts"

type Tool = RolloutTool<never>

/** A frozen loading tool resolves to the registered one; its frozen description stays as sent. */
export const loaderFor = (execution: ExecutionRegistry["Service"], frozen: FrozenTool): Tool | undefined =>
  LOADERS.has(frozen.name) ? execution.toolLoaders.get(frozen.name) : undefined

/** The registered wire that carries deferred tools for this model, if any supports it. */
export const loadingWireFor = (execution: ExecutionRegistry["Service"], model: ModelInput | null) => {
  const wire = model ? execution.toolLoadingWires.get(model.api) : undefined
  return wire && model && wire.supports(model) ? wire : undefined
}

export const planToolLoading = (
  deps: {
    readonly execution: ExecutionRegistry["Service"]
    readonly reader: Reader["Service"]
    readonly userId: UserId
  },
  input: {
    readonly kind: string
    readonly tools: ReadonlyArray<Tool>
    readonly model: ModelInput | null
    readonly cards: ReadonlyArray<{ readonly entity: string; readonly ref: string | null; readonly revision: string }>
  }
): Effect.Effect<{ readonly offer: ToolOffer<Tool>; readonly cardSkills: ReadonlyArray<Skill> }> =>
  Effect.gen(function* () {
    const { execution } = deps
    const profile = execution.toolLoadingProfiles.get(input.kind)
    const wire = input.model ? execution.toolLoadingWires.get(input.model.api) : undefined
    const unsplit = { offer: { tools: input.tools, deferred: new Set<string>() }, cardSkills: [] }
    if (!profile || !wire || !input.model || !wire.supports(input.model)) return unsplit
    // The cards the assistant speaks as, at the revisions this request was assembled with.
    const cards = yield* Effect.forEach(input.cards, (card) =>
      card.ref === null
        ? Effect.succeed(null)
        : deps.reader
            .GetRevisionDoc({ userId: deps.userId, refId: card.ref as RefId, revisionId: card.revision as RevisionId })
            .pipe(
              Effect.map((doc) => {
                const d = doc as { readonly name?: string; readonly extensions?: Readonly<Record<string, unknown>> }
                return readCardSkills(d, { entity: card.entity, name: d.name ?? "the card" })
              }),
              Effect.orElseSucceed(() => null)
            )
    )
    const skills = runSkills(
      execution.skills.list(),
      input.kind,
      cards.flatMap((c) => (c ? [c] : []))
    )
    let listed: ReadonlyArray<Skill> = []
    const offer = splitOffer({
      tools: input.tools,
      profile,
      wire,
      target: input.model,
      loaders: (deferred) => {
        const names = deferred.map((t) => t.id)
        listed = skillsFor(skills, names)
        const search = execution.toolLoaders.get(TOOL_SEARCH)
        const load = execution.toolLoaders.get(LOAD_SKILL)
        return [
          ...(search ? [{ ...search, description: toolSearchDescription(orphansOf(names, listed)) }] : []),
          ...(load && listed.length ? [{ ...load, description: loadSkillDescription(listed) }] : [])
        ]
      }
    })
    return { offer, cardSkills: listed }
  })
