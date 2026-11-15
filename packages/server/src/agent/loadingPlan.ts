// Planning a run's tool loading (spec/TOOL-LOADING.md §3): reads the workshop cards' skills at the
// revisions the assembly used, then splits the offer through the registered profile and wire. With
// no wire for the model (every tool from the start), the run still offers load_skill for the same
// skills, so skills work alike in every mode; nothing is deferred.
import type { RefId, RevisionId } from "@rp/shared/library.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import type { AgentSkills, ModelInput } from "../assembler/types.ts"
import type { Reader } from "../db/Database.ts"
import type { ExecutionRegistry } from "../execution.ts"
import {
  cardSkills as readCardSkills,
  loadableTools,
  loadSkillDescription,
  LOADERS,
  offeredSkills,
  orphansOf,
  type Skill,
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
  if (!model || model.toolLoading === "every") return undefined
  if (model.toolLoading !== "dispatcher" && wire?.supports(model)) return wire
  const dispatcher = execution.toolLoadingWires.get("dispatcher")
  return dispatcher?.supports(model) ? dispatcher : undefined
}

/** The tools this user may be offered: admin-only ones only to an admin. */
export const offerableTools = (
  deps: { readonly reader: Reader["Service"]; readonly userId: UserId },
  tools: ReadonlyArray<Tool>
): Effect.Effect<ReadonlyArray<Tool>> =>
  Effect.gen(function* () {
    const actor = tools.some((t) => t.adminOnly)
      ? yield* deps.reader.WorkshopOperationInfo({ userId: deps.userId }).pipe(
          Effect.map((info) => info.user),
          Effect.orElseSucceed(() => undefined)
        )
      : undefined
    return tools.filter((t) => !t.adminOnly || actor?.role === "admin")
  })

/**
 * What the assembler needs for the preset's skill markers (spec/WORKSHOP-CONTEXT.md §4.2): the
 * same inputs `planToolLoading` lists the run's skills from, less the cards, which the assembly
 * reads itself at the revisions it uses. Undefined where the run offers no skills.
 */
export const skillMarkerInput = (
  execution: ExecutionRegistry["Service"],
  kind: string,
  tools: ReadonlyArray<Tool>
): AgentSkills | undefined => {
  const loadable = loadableTools(
    tools.map((t) => t.id),
    execution.toolLoadingProfiles.get(kind)
  )
  if (loadable.length === 0 || !execution.toolLoaders.get(LOAD_SKILL)) return undefined
  return {
    kind,
    registered: execution.skills.list().map((s) => ({
      id: s.id,
      description: s.description,
      tools: s.tools,
      ...(s.kinds ? { kinds: s.kinds } : {}),
      ...(s.always === undefined ? {} : { always: s.always })
    })),
    loadable
  }
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
    const tools = yield* offerableTools(deps, input.tools)
    const profile = execution.toolLoadingProfiles.get(input.kind)
    const wire = loadingWireFor(execution, input.model)
    const unsplit = { offer: { tools, deferred: new Set<string>() }, cardSkills: [] }
    // Skills don't depend on the wire: a kind whose profile leaves tools for loading has them in
    // every mode (spec/TOOL-LOADING.md §5). RP and kinds without a profile keep their exact offer.
    const loadable = loadableTools(
      tools.map((t) => t.id),
      profile
    )
    if (!profile || !input.model || loadable.length === 0) return unsplit
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
    const listed = offeredSkills(
      execution.skills.list(),
      input.kind,
      cards.flatMap((c) => (c ? [c] : [])),
      loadable
    )
    const load = execution.toolLoaders.get(LOAD_SKILL)
    const loader = load && listed.length ? { ...load, description: loadSkillDescription(listed) } : undefined
    if (!wire || !wire.supports(input.model)) {
      // Every tool from the start: nothing to load but the skills' instructions, so load_skill
      // alone comes after the tools, frozen with them. Its index is the one the loading modes send.
      if (!loader) return unsplit
      return { offer: { tools: [...tools, loader], deferred: new Set<string>() }, cardSkills: listed }
    }
    let offered: ReadonlyArray<Skill> = []
    const offer = splitOffer({
      tools,
      profile,
      wire,
      target: input.model,
      loaders: (deferred) => {
        const names = deferred.map((t) => t.id)
        offered = listed
        const search = execution.toolLoaders.get(TOOL_SEARCH)
        return [
          ...(search ? [{ ...search, description: toolSearchDescription(orphansOf(names, listed)) }] : []),
          ...(loader ? [loader] : [])
        ]
      }
    })
    return { offer, cardSkills: offered }
  })
