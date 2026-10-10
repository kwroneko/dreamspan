// Chat state on the graph (DESIGN §3.4, DATA-MODEL §5). Every change to chat state is
// an event at a position; the state at a slot is the fold of the events on the path
// to it. The fold is a pure function so the server and the client agree on it.
import { Schema } from "effect"
import { EntityId } from "./chat.ts"

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
export type StateKey = StateEventData["key"]

/** A state event as the fold sees it: its data plus the optional scope (a role, an entity). */
export interface FoldableEvent {
  readonly data: StateEventData
  readonly scope: string | null
}

export interface Binding {
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

export const emptyChatState: ChatState = {
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
