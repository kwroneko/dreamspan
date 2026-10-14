import { LcmSettings } from "./lcmSettings.ts"
// Chat state on the graph (DESIGN §3.4, DATA-MODEL §5). Every change to chat state is
// an event at a position; the state at a slot is the fold of the events on the path
// to it. The fold is a pure function so the server and the client agree on it.
import { Schema, type SchemaAST } from "effect"
import { EntityId } from "./chat.ts"
import { ID_TABLE } from "./id.ts"
import { type EntityKind, RefId, RevisionId } from "./library.ts"
import { ConnectionId, ModelId } from "./providers.ts"

const event = <K extends string, V extends Schema.Top>(key: K, value: V) =>
  Schema.Struct({ key: Schema.Literal(key), value })

/**
 * The typed state-event keys (DATA-MODEL §5.3). Unknown keys are rejected on write. Ids
 * use the id schemas, never a plain string, so `stateKeyProblems` can find them.
 */
export const StateEventData = Schema.Union([
  event("lcm.settings", LcmSettings),
  event("participant.join", Schema.Struct({ entity: EntityId })),
  event("participant.leave", Schema.Struct({ entity: EntityId })),
  event("presence.set", Schema.Struct({ entity: EntityId, present: Schema.Boolean })),
  event("played_by_me.set", Schema.Struct({ entities: Schema.Array(EntityId) })),
  event(
    "card.binding",
    Schema.Struct({ entity: EntityId, ref: Schema.optional(RefId), revision: Schema.optional(RevisionId) })
  ),
  event("note.activate", Schema.Struct({ note: EntityId })),
  event("note.deactivate", Schema.Struct({ note: EntityId })),
  event("note.binding", Schema.Struct({ note: EntityId, revision: RevisionId })),
  event("preset.binding", Schema.Struct({ ref: Schema.optional(RefId), revision: Schema.optional(RevisionId) })),
  event("preset_overlay.binding", Schema.Struct({ overlay: EntityId, on: Schema.Boolean })),
  event("model.binding", Schema.Struct({ connection: ConnectionId, model: ModelId })),
  /** The scope's `preset.binding` or `model.binding` taken off: it follows the default again. */
  event("preset.unbind", Schema.Struct({})),
  event("model.unbind", Schema.Struct({})),
  event("layout.cards", Schema.Literals(["concat", "swap_tail"])),
  event("roles.projection", Schema.Literals(["by_writer", "alternate", "perspective"])),
  event("macro.binding", Schema.Struct({ name: Schema.String, value: Schema.String })),
  event("orchestration.mode", Schema.Struct({ mode: Schema.String, config: Schema.optional(Schema.Unknown) })),
  event("output.contract", Schema.Literals(["final_text", "send_message", "both"])),
  event("rollout.continuity", Schema.Literals(["fork", "resume_previous"])),
  event("lorebook.binding", Schema.Struct({ entity: EntityId, ref: Schema.NullOr(RefId) })),
  event("lorebook.attach", Schema.Struct({ ref: RefId })),
  event("lorebook.detach", Schema.Struct({ ref: RefId })),
  /** A card's own lorebook (`character_book`) used or not; on unless a chat turns it off. */
  event("lorebook.embedded", Schema.Struct({ entity: EntityId, on: Schema.Boolean })),
  event("var.set", Schema.Struct({ name: Schema.String, value: Schema.Unknown })),
  event("author_note.set", Schema.Struct({ note: EntityId }))
])
export type StateEventData = typeof StateEventData.Type

/**
 * What an id in a state value names. `entity`, `ref` and `connection` name another field
 * of the same value: a ref or revision of that entity, a revision of that ref's entity, a
 * model of that connection.
 */
/** `chatOwned` also checks a note document's owner.chat when present. */
type IdField<F extends string> =
  | { readonly table: "entity"; readonly kind: EntityKind; readonly chatOwned?: true }
  | { readonly table: "ref"; readonly kind: EntityKind; readonly entity?: F }
  | { readonly table: "revision"; readonly kind: EntityKind; readonly entity?: F; readonly ref?: F }
  | { readonly table: "connection" }
  | { readonly table: "model"; readonly connection: F }

/** The fields of a value that can hold ids: strings and arrays of strings. */
type IdFieldName<V> = {
  [F in keyof V & string]-?: NonNullable<V[F]> extends string | ReadonlyArray<string> ? F : never
}[keyof V & string]

/**
 * The id fields of a key's value, which the writer checks against the acting user
 * (db/stateRefs.ts). A key that `removes` something may name a deleted thing.
 * `stateKeyProblems` checks a declaration against its value schema.
 */
export interface StateKeyIds<V> {
  readonly ids: { readonly [F in IdFieldName<V>]?: IdField<IdFieldName<V>> }
  readonly removes?: true
}

type ValueOf<K extends StateEventData["key"]> = Extract<StateEventData, { readonly key: K }>["value"]

/** Every core key's id fields; a new key doesn't compile until it's listed. */
export const stateKeyIds: { readonly [K in StateEventData["key"]]: StateKeyIds<ValueOf<K>> } = {
  "lcm.settings": { ids: {} },
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
  "note.activate": { ids: { note: { table: "entity", kind: "note", chatOwned: true } } },
  "note.deactivate": { ids: { note: { table: "entity", kind: "note", chatOwned: true } }, removes: true },
  "note.binding": {
    ids: {
      note: { table: "entity", kind: "note", chatOwned: true },
      revision: { table: "revision", kind: "note", entity: "note" }
    }
  },
  "preset.binding": {
    ids: { ref: { table: "ref", kind: "preset" }, revision: { table: "revision", kind: "preset", ref: "ref" } }
  },
  "preset_overlay.binding": { ids: { overlay: { table: "entity", kind: "preset_overlay" } } },
  "model.binding": {
    ids: { connection: { table: "connection" }, model: { table: "model", connection: "connection" } }
  },
  "preset.unbind": { ids: {} },
  "model.unbind": { ids: {} },
  "layout.cards": { ids: {} },
  "roles.projection": { ids: {} },
  "macro.binding": { ids: {} },
  "orchestration.mode": { ids: {} },
  "output.contract": { ids: {} },
  "rollout.continuity": { ids: {} },
  "lorebook.binding": { ids: { entity: { table: "entity", kind: "card" }, ref: { table: "ref", kind: "lorebook" } } },
  "lorebook.attach": { ids: { ref: { table: "ref", kind: "lorebook" } } },
  "lorebook.detach": { ids: { ref: { table: "ref", kind: "lorebook" } }, removes: true },
  "lorebook.embedded": { ids: { entity: { table: "entity", kind: "card" } } },
  "var.set": { ids: {} },
  "author_note.set": { ids: { note: { table: "entity", kind: "note", chatOwned: true } } }
}

/**
 * Where ids sit in a schema: `field`, `field[]`, or deeper (`.<key>` for a record's keys),
 * with the table each names. Where ids can't be found, `hidden` says why.
 */
type Position = { readonly path: string; readonly table: string } | { readonly path: string; readonly hidden: string }

const idPositions = (ast: SchemaAST.AST, path: string): ReadonlyArray<Position> => {
  const table = ast.annotations?.[ID_TABLE]
  if (typeof table === "string") return [{ path, table }]
  switch (ast._tag) {
    case "Union":
      return ast.types.flatMap((member) => idPositions(member, path))
    case "Arrays":
      return [...ast.elements, ...ast.rest].flatMap((element) => idPositions(element, `${path}[]`))
    case "Objects":
      return [
        ...ast.propertySignatures.flatMap((p) =>
          idPositions(p.type, path === "" ? String(p.name) : `${path}.${String(p.name)}`)
        ),
        ...ast.indexSignatures.flatMap((index) => [
          ...idPositions(index.parameter, `${path}.<key>`),
          ...idPositions(index.type, `${path}.*`)
        ])
      ]
    case "Declaration":
      return ast.typeParameters.flatMap((parameter) => idPositions(parameter, path))
    case "TemplateLiteral":
      return ast.parts.some((part) => idPositions(part, path).length > 0)
        ? [{ path, hidden: "an id inside a template literal can't be checked" }]
        : []
    case "Suspend":
      return [{ path, hidden: "a suspended schema isn't searched" }]
    default:
      return []
  }
}

/**
 * What's wrong with a key's declaration, given its value schema; empty when nothing is.
 * Every id in the value must sit in a top-level field (or an array in one), be declared
 * there with the table its schema names, and every declared field must hold one. An id
 * typed as a plain string isn't seen.
 */
export const stateKeyProblems = (
  value: SchemaAST.AST,
  declared: StateKeyIds<Readonly<Record<string, string | ReadonlyArray<string>>>>
): ReadonlyArray<string> => {
  const positions = idPositions(value, "")
  const problems: Array<string> = []
  for (const position of positions) {
    const { path } = position
    if ("hidden" in position) {
      problems.push(`"${path}": ${position.hidden}`)
      continue
    }
    const { table } = position
    const field = /^[^.[\]*<>]+(\[\])?$/.test(path) ? path.replace("[]", "") : undefined
    const declaration = field === undefined ? undefined : declared.ids[field]
    if (field === undefined) problems.push(`${table} id at "${path}" isn't in a top-level field`)
    else if (declaration === undefined) problems.push(`${table} id in "${field}" isn't declared`)
    else if (declaration.table !== table) {
      problems.push(`"${field}" holds ${table} ids but is declared as ${declaration.table}`)
    }
  }
  for (const field of Object.keys(declared.ids)) {
    if (!positions.some(({ path }) => path === field || path === `${field}[]`)) {
      problems.push(`"${field}" is declared as an id but its schema isn't an id schema`)
    }
  }
  return problems
}

/** The roles an event can be scoped to (DATA-MODEL §5.3). */
const StateRole = Schema.Literals(["narrator", "summarizer"])
export const isStateRole = Schema.is(StateRole)

/**
 * What an event applies to, when not the whole chat: a role, or a participant, which is a
 * card of the user's. A participant is checked like a value's ids (`scopeIds`).
 */
const StateScope = Schema.Union([StateRole, EntityId])
export const scopeIds: StateKeyIds<{ readonly scope: EntityId }> = {
  ids: { scope: { table: "entity", kind: "card" } }
}

/** A state event as the fold sees it: its data plus the optional scope. */
export const FoldableEvent = Schema.Struct({ scope: Schema.NullOr(StateScope), data: StateEventData })
export type FoldableEvent = typeof FoldableEvent.Type

interface Binding {
  readonly ref?: string | undefined
  readonly revision?: string | undefined
}

export interface ChatState {
  readonly lcm: typeof LcmSettings.Type | null
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
  readonly lorebookBindings: Readonly<Record<string, string | null>>
  readonly lorebooks: ReadonlyArray<string>
  /** Cards whose own lorebook is turned off (false) or back on; absent is on. */
  readonly embeddedLorebooks: Readonly<Record<string, boolean>>
  readonly vars: Readonly<Record<string, unknown>>
  readonly authorNote: string | null
}

const emptyChatState: ChatState = {
  lcm: null,
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
  lorebookBindings: {},
  lorebooks: [],
  embeddedLorebooks: {},
  vars: {},
  authorNote: null
}

const add = (list: ReadonlyArray<string>, item: string) => (list.includes(item) ? list : [...list, item])
const remove = (list: ReadonlyArray<string>, item: string) => list.filter((x) => x !== item)

const apply = (state: ChatState, { data, scope }: FoldableEvent): ChatState => {
  const at = scope ?? ""
  switch (data.key) {
    case "lcm.settings":
      return { ...state, lcm: data.value }
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
    case "preset.unbind": {
      const { [at]: _gone, ...presetBindings } = state.presetBindings
      return { ...state, presetBindings }
    }
    case "model.unbind": {
      const { [at]: _gone, ...modelBindings } = state.modelBindings
      return { ...state, modelBindings }
    }
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
    case "lorebook.binding":
      return { ...state, lorebookBindings: { ...state.lorebookBindings, [data.value.entity]: data.value.ref } }
    case "lorebook.attach":
      return { ...state, lorebooks: add(state.lorebooks, data.value.ref) }
    case "lorebook.detach":
      return { ...state, lorebooks: remove(state.lorebooks, data.value.ref) }
    case "lorebook.embedded":
      return { ...state, embeddedLorebooks: { ...state.embeddedLorebooks, [data.value.entity]: data.value.on } }
    case "var.set":
      return { ...state, vars: { ...state.vars, [data.value.name]: data.value.value } }
    case "author_note.set":
      return { ...state, authorNote: data.value.note }
  }
}

/**
 * The notes the events turned on or off, as they last left each (DESIGN §4.1). A note they
 * never named keeps its default: a card's first note is on, every other note off.
 */
export const noteSwitches = (events: Iterable<FoldableEvent>) => {
  const last = new Map<string, boolean>()
  for (const { data } of events) {
    if (data.key === "note.activate") last.set(data.value.note, true)
    if (data.key === "note.deactivate") last.set(data.value.note, false)
  }
  return last
}

/** Folds events, given in path order (position, then seq), into the state after them. */
export const foldState = (events: Iterable<FoldableEvent>, initial: ChatState = emptyChatState): ChatState => {
  let state = initial
  for (const e of events) state = apply(state, e)
  return state
}
