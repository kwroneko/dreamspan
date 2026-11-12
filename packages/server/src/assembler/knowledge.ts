// Context per speaker (spec/CHARACTER-CONTEXT.md §2, §9.2 unit C3; owner decisions DESIGN §7.1
// and CHARACTER-CONTEXT §2.1 [D] 2026-11-06). A chat names how each reply's history is chosen
// (`context.per_speaker`, an open id resolved at use) against the assembler's `contextViews`
// registry: one shared context (every reply sees the whole path, as before) or separate
// contexts (a reply sees only what its speaker was present for). The `knowledge` stage, before
// `lcm` and `history`, resolves the view and its viewer; the history stage then leaves out what
// the viewer doesn't know, before it counts the budget, and the lcm stage withholds the summary
// layer where it covers something the viewer doesn't know. The stage and the views are each
// registered and replaceable.
import { Effect } from "effect"
import { makeRegistry, type Registry } from "../registry.ts"
import { AssemblySources, need, type Assembly, type AssemblerStage, type Cast } from "./pipeline.ts"
import type { HistoryEntry } from "./types.ts"

export interface ContextView {
  readonly id: string
  /** Shown where the chat's setting is chosen. */
  readonly label: string
  readonly description: string
  /**
   * The card whose knowledge this request's history is filtered by: what it was present for
   * (`@rp/shared/knowledge.ts`). Null: the whole path, as one shared context sends it.
   */
  readonly viewer: (input: {
    readonly assembly: Assembly
    readonly cast: Cast
    readonly roles: Readonly<Record<string, string>>
  }) => string | null
}

export type ContextViewRegistry = Registry<ContextView>

export const makeContextViewRegistry = (): ContextViewRegistry => makeRegistry<ContextView>()

const CONTEXT_VIEW_DEFAULT = "shared"

/** One shared context (the default): every reply sees the whole path. */
const sharedView: ContextView = {
  id: "shared",
  label: "One shared context",
  description: "Every reply sees the whole chat, whoever was present for it.",
  viewer: () => null
}

/**
 * Separate contexts: a character's reply sees only what it was present for. A narrator, a
 * persona's turn, a reply with no speaker, a summary and a text being rewritten see the whole
 * path (§6 [D]: the narrator sees everything).
 */
const separateView: ContextView = {
  id: "separate",
  label: "Separate contexts",
  description: "Each character's reply sees only what that character was present for.",
  viewer: ({ assembly, cast, roles }) => {
    if (assembly.request.summaryJob || assembly.request.rewrite) return null
    const speaker = cast.speaker
    if (speaker === null || cast.personas.some((p) => p.entity === speaker.entity)) return null
    if (roles[speaker.entity] === "narrator") return null
    return speaker.entity
  }
}

export const builtinContextViews: ReadonlyArray<ContextView> = [sharedView, separateView]

const fallbackViews = (() => {
  const map = new Map(builtinContextViews.map((view) => [view.id, view]))
  return { get: (id: string) => map.get(id), list: () => builtinContextViews }
})()

/** The view this request's history is chosen by, and whose knowledge filters it. */
export interface Knowledge {
  readonly view: string
  /** The card the history is filtered for; null: the whole path. */
  readonly viewer: string | null
}

/**
 * Resolves the chat's view. An id nothing registers (a plugin turned off) records
 * `context_view_missing` and uses separate contexts, the stricter built-in: a reply never sees
 * more than the chat asked for.
 */
export const knowledgeStage: AssemblerStage = {
  id: "knowledge",
  run: (assembly) =>
    Effect.sync(() => {
      const state = need(assembly, "state")
      const cast = need(assembly, "cast")
      const views = assembly.request.contextViews ?? fallbackViews
      const chosen = state.contextPerSpeaker ?? CONTEXT_VIEW_DEFAULT
      const found = views.get(chosen)
      if (!found)
        assembly.issues.push({
          kind: "context_view_missing",
          message: `This chat's context setting "${chosen}" isn't installed (a plugin may be off); each reply sees only what its speaker was present for instead.`
        })
      const view = found ?? views.get("separate") ?? separateView
      assembly.knowledge = { view: view.id, viewer: view.viewer({ assembly, cast, roles: state.roles }) }
      return assembly
    })
}

/**
 * A window's messages with those the viewer doesn't know left out: kept in place, so the
 * numbering and the history's positions stay, but not in the context (`unknown`).
 */
export const withoutUnknown = (assembly: Assembly, entries: ReadonlyArray<HistoryEntry>) =>
  Effect.gen(function* () {
    const viewer = assembly.knowledge?.viewer ?? null
    const sources = yield* AssemblySources
    if (viewer === null || !sources.knowers) return entries
    const ids = entries.filter((e) => e.inContext).map((e) => e.versionId)
    if (ids.length === 0) return entries
    const known = new Map((yield* sources.knowers(ids)).map((k) => [k.versionId, k.knowers]))
    return entries.map((entry) => {
      const knowers = known.get(entry.versionId)
      if (!entry.inContext || knowers === undefined || knowers === null || knowers.includes(viewer)) return entry
      const hidden: HistoryEntry = { ...entry, inContext: false, unknown: { knowers } }
      return hidden
    })
  })

/**
 * Whether the summary layer can be used for the viewer: none of what it covers (the path
 * through its cursor) is a message the viewer doesn't know. Until summaries are kept per view
 * (unit C7) a layer that does is withheld, and the history is read from the start instead.
 */
export const layerKnown = (assembly: Assembly, leaf: string | null, cursorDepth: number) =>
  Effect.gen(function* () {
    const viewer = assembly.knowledge?.viewer ?? null
    const sources = yield* AssemblySources
    if (viewer === null || leaf === null || cursorDepth < 0 || !sources.knewThrough) return true
    return yield* sources.knewThrough(leaf, viewer, cursorDepth)
  })
