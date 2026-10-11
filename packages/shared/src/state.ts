// Chat state on the graph (DESIGN §3.4, DATA-MODEL §5). Every change to chat state is
// an event at a position; the state at a slot is the fold of the events on the path
// to it. The fold is a pure function so the server and the client agree on it.
import { Schema } from "effect"
import { EntityId } from "./chat.ts"
import type { EntityKind } from "./library.ts"

const Id = Schema.String
const event = <K extends string, V extends Schema.Top>(key: K, value: V) =>
  Schema.Struct({ key: Schema.Literal(key), value })

/** The typed state-event keys (DATA-MODEL §5.3). Unknown keys are rejected on write. */
export const StateEventData = Schema.Union([
  event("participant.join", Schema.Struct({ entity: EntityId })),
  event("participant.leave", Schema.Struct({ entity: EntityId })),
  event("presence.set", Schema.Struct({ entity: EntityId, present: Schema.Boolean })),
  event("played_by_me.set", Schema.Struct({ entities: Schema.Array(EntityId) })),
  event("card.binding", Schema.Struct({ entity: EntityId, ref: Schema.optional(Id), revision: Schema.optional(Id) })),
  event("note.activate", Schema.Struct({ note: EntityId })),
  event("note.deactivate", Schema.Struct({ note: EntityId })),
  event("note.binding", Schema.Struct({ note: EntityId, revision: Id })),
  event("preset.binding", Schema.Struct({ ref: Schema.optional(Id), revision: Schema.optional(Id) })),
  event("preset_overlay.binding", Schema.Struct({ overlay: EntityId, on: Schema.Boolean })),
  event("model.binding", Schema.Struct({ connection: Id, model: Id })),
  event("layout.cards", Schema.Literals(["concat", "swap_tail"])),
  event("roles.projection", Schema.Literals(["by_writer", "alternate", "perspective"])),
  event("macro.binding", Schema.Struct({ name: Schema.String, value: Schema.String })),
  event("orchestration.mode", Schema.Struct({ mode: Schema.String, config: Schema.optional(Schema.Unknown) })),
  event("output.contract", Schema.Literals(["final_text", "send_message", "both"])),
  event("rollout.continuity", Schema.Literals(["fork", "resume_previous"])),
  event("lorebook.attach", Schema.Struct({ ref: Id })),
  event("lorebook.detach", Schema.Struct({ ref: Id })),
  event("var.set", Schema.Struct({ name: Schema.String, value: Schema.Unknown })),
  event("author_note.set", Schema.Struct({ note: EntityId }))
])
export type StateEventData = typeof StateEventData.Type

/**
 * What an id in a state value names. `entity`, `ref` and `connection` name another field
 * of the same value: a ref or revision of that entity, a revision of that ref's entity, a
 * model of that connection.
 */
type IdField<F extends string> =
  | { readonly table: "entity"; readonly kind: EntityKind }
  | { readonly table: "ref"; readonly kind: EntityKind; readonly entity?: F }
  | { readonly table: "revision"; readonly kind: EntityKind; readonly entity?: F; readonly ref?: F }
  | { readonly table: "connection" }
  | { readonly table: "model"; readonly connection: F }

/** The fields of a value that can hold ids: strings and arrays of strings. */
type IdFieldName<V> = {
  [F in keyof V & string]-?: NonNullable<V[F]> extends string | ReadonlyArray<string> ? F : never
}[keyof V & string]

/**
 * What each string field of a key's value holds: an id, which the writer checks against
 * the acting user (db/stateRefs.ts), or `"text"`. Every one must be listed, so a new field
 * can't skip the check by accident. Whatever reads an id out of text, or out of a field
 * that isn't a string, must check ownership itself. A key that `removes` something may
 * name a deleted thing.
 */
export interface StateKeyIds<V> {
  readonly ids: { readonly [F in IdFieldName<V>]: IdField<IdFieldName<V>> | "text" }
  readonly removes?: true
}

type ValueOf<K extends StateEventData["key"]> = Extract<StateEventData, { readonly key: K }>["value"]

/**
 * Every core key's id fields; a new key doesn't compile until it's listed. A plugin's key
 * will be `<plugin-id>/<key>` (core keys have no slash) and register its value schema with
 * a `StateKeyIds`, so the same check covers it (spec/PLUGINS.md §8).
 */
export const stateKeyIds: { readonly [K in StateEventData["key"]]: StateKeyIds<ValueOf<K>> } = {
  "participant.join": { ids: { entity: { table: "entity", kind: "card" } } },
  "participant.leave": { ids: { entity: { table: "entity", kind: "card" } }, removes: true },
  "presence.set": { ids: { entity: { table: "entity", kind: "card" } }, removes: true },
  "played_by_me.set": { ids: { entities: { table: "entity", kind: "card" } } },
  "card.binding": {
    ids: {
      entity: { table: "entity", kind: "card" },
      ref: { table: "ref", kind: "card", entity: "entity" },
      revision: { table: "revision", kind: "card", entity: "entity" }
    }
  },
  "note.activate": { ids: { note: { table: "entity", kind: "note" } } },
  "note.deactivate": { ids: { note: { table: "entity", kind: "note" } }, removes: true },
  "note.binding": {
    ids: { note: { table: "entity", kind: "note" }, revision: { table: "revision", kind: "note", entity: "note" } }
  },
  "preset.binding": {
    ids: { ref: { table: "ref", kind: "preset" }, revision: { table: "revision", kind: "preset", ref: "ref" } }
  },
  "preset_overlay.binding": { ids: { overlay: { table: "entity", kind: "preset_overlay" } } },
  "model.binding": {
    ids: { connection: { table: "connection" }, model: { table: "model", connection: "connection" } }
  },
  "layout.cards": { ids: {} },
  "roles.projection": { ids: {} },
  "macro.binding": { ids: { name: "text", value: "text" } },
  "orchestration.mode": { ids: { mode: "text" } },
  "output.contract": { ids: {} },
  "rollout.continuity": { ids: {} },
  "lorebook.attach": { ids: { ref: { table: "ref", kind: "lorebook" } } },
  "lorebook.detach": { ids: { ref: { table: "ref", kind: "lorebook" } }, removes: true },
  "var.set": { ids: { name: "text" } },
  "author_note.set": { ids: { note: { table: "entity", kind: "note" } } }
}

/** A state event as the fold sees it: its data plus the optional scope (a role, an entity). */
export const FoldableEvent = Schema.Struct({ scope: Schema.NullOr(Schema.String), data: StateEventData })
export type FoldableEvent = typeof FoldableEvent.Type

interface Binding {
  readonly ref?: string | undefined
  readonly revision?: string | undefined
}

export interface ChatState {
  /** In join order. */
  readonly participants: ReadonlyArray<string>
  readonly absent: ReadonlyArray<string>
  readonly playedByMe: ReadonlyArray<string>
  readonly activeNotes: ReadonlyArray<string>
  readonly noteRevisions: Readonly<Record<string, string>>
  readonly cardBindings: Readonly<Record<string, Binding>>
  /** Keyed by scope (a role such as "narrator" or "summarizer"), "" for the chat default. */
  readonly presetBindings: Readonly<Record<string, Binding>>
  readonly presetOverlays: Readonly<Record<string, boolean>>
  readonly modelBindings: Readonly<Record<string, { readonly connection: string; readonly model: string }>>
  readonly layoutCards: "concat" | "swap_tail" | null
  readonly rolesProjection: "by_writer" | "alternate" | "perspective" | null
  readonly macroBindings: Readonly<Record<string, string>>
  readonly orchestration: { readonly mode: string; readonly config?: unknown } | null
  readonly outputContract: "final_text" | "send_message" | "both" | null
  readonly rolloutContinuity: "fork" | "resume_previous" | null
  readonly lorebooks: ReadonlyArray<string>
  readonly vars: Readonly<Record<string, unknown>>
  readonly authorNote: string | null
}

const emptyChatState: ChatState = {
  participants: [],
  absent: [],
  playedByMe: [],
  activeNotes: [],
  noteRevisions: {},
  cardBindings: {},
  presetBindings: {},
  presetOverlays: {},
  modelBindings: {},
  layoutCards: null,
  rolesProjection: null,
  macroBindings: {},
  orchestration: null,
  outputContract: null,
  rolloutContinuity: null,
  lorebooks: [],
  vars: {},
  authorNote: null
}

const add = (list: ReadonlyArray<string>, item: string) => (list.includes(item) ? list : [...list, item])
const remove = (list: ReadonlyArray<string>, item: string) => list.filter((x) => x !== item)

const apply = (state: ChatState, { data, scope }: FoldableEvent): ChatState => {
  const at = scope ?? ""
  switch (data.key) {
    case "participant.join":
      return {
        ...state,
        participants: add(state.participants, data.value.entity),
        absent: remove(state.absent, data.value.entity)
      }
    case "participant.leave":
      return { ...state, participants: remove(state.participants, data.value.entity) }
    case "presence.set":
      return {
        ...state,
        absent: data.value.present ? remove(state.absent, data.value.entity) : add(state.absent, data.value.entity)
      }
    case "played_by_me.set":
      return { ...state, playedByMe: [...data.value.entities] }
    case "card.binding":
      return {
        ...state,
        cardBindings: {
          ...state.cardBindings,
          [data.value.entity]: { ref: data.value.ref, revision: data.value.revision }
        }
      }
    case "note.activate":
      return { ...state, activeNotes: add(state.activeNotes, data.value.note) }
    case "note.deactivate":
      return { ...state, activeNotes: remove(state.activeNotes, data.value.note) }
    case "note.binding":
      return { ...state, noteRevisions: { ...state.noteRevisions, [data.value.note]: data.value.revision } }
    case "preset.binding":
      return {
        ...state,
        presetBindings: { ...state.presetBindings, [at]: { ref: data.value.ref, revision: data.value.revision } }
      }
    case "preset_overlay.binding":
      return { ...state, presetOverlays: { ...state.presetOverlays, [data.value.overlay]: data.value.on } }
    case "model.binding":
      return { ...state, modelBindings: { ...state.modelBindings, [at]: data.value } }
    case "layout.cards":
      return { ...state, layoutCards: data.value }
    case "roles.projection":
      return { ...state, rolesProjection: data.value }
    case "macro.binding":
      return { ...state, macroBindings: { ...state.macroBindings, [data.value.name]: data.value.value } }
    case "orchestration.mode":
      return { ...state, orchestration: data.value }
    case "output.contract":
      return { ...state, outputContract: data.value }
    case "rollout.continuity":
      return { ...state, rolloutContinuity: data.value }
    case "lorebook.attach":
      return { ...state, lorebooks: add(state.lorebooks, data.value.ref) }
    case "lorebook.detach":
      return { ...state, lorebooks: remove(state.lorebooks, data.value.ref) }
    case "var.set":
      return { ...state, vars: { ...state.vars, [data.value.name]: data.value.value } }
    case "author_note.set":
      return { ...state, authorNote: data.value.note }
  }
}

/** Folds events, given in path order (position, then seq), into the state after them. */
export const foldState = (events: Iterable<FoldableEvent>, initial: ChatState = emptyChatState): ChatState => {
  let state = initial
  for (const e of events) state = apply(state, e)
  return state
}
