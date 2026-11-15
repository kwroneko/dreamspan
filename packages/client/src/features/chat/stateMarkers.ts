// The timeline's change markers (DESIGN §3.4): a quiet line under the message after which
// something the next replies are written from changed: who's in the chat, who's muted, which
// notes are on, the chat's own model or preset, a lorebook, a chat setting. Derived from the
// state events recorded on the branch's path (`GetStateMarks`, one read a branch, leaf and state
// change, shared by every row on screen); nothing of its own is stored, and nothing here reaches
// a request, a summary, an export, search or message numbering.
//
// Where a marker sits: the assembler writes a message from the state through its parent, so an
// event recorded at a message applies to the replies after it. Each marker is the net change of
// one kind across the events of one message: a change taken back there shows nothing.
//
// Each kind is an entry of `stateMarkerKinds` (spec/PLUGINS.md §8) with the state keys it reads,
// its own fold over them and the changes between two folded states, so a plugin adds a kind for
// its own keys, or replaces or disables one of these; the Interface settings list a switch per kind.
import type { ForkId, SlotId } from "@rp/shared/chat.ts"
import type { StateMarkEvent, StateMarks } from "@rp/shared/contextsApi.ts"
import { type ChatState, foldState } from "@rp/shared/state.ts"
import { makeRegistry } from "../../registry.ts"
import type { ChatSession } from "./session.ts"

/** One thing that changed at a position, in a few plain words. */
export interface StateChange {
  /** Stable among its position's changes. */
  readonly id: string
  /** "Wren joined", "Model: A → B". */
  readonly text: string
  /** On hover: what follows from it. */
  readonly explanation: string
}

interface MarkContext {
  /** The name of a card, note, preset, lorebook, model or connection an event names; null: gone for good. */
  readonly name: (id: string | null | undefined) => string | null
  readonly notes: StateMarks["notes"]
}

export interface StateMarkerKind<S = unknown> {
  readonly id: string
  /** The module that registered it (built-in module provenance, as the other client registries). */
  readonly source: string
  readonly order: number
  /** Its switch in the Interface settings, and what it shows. */
  readonly label: string
  readonly description: string
  /** The state keys it reads; only their events are fetched. */
  readonly keys: ReadonlyArray<string>
  /** Shown in a workshop too; otherwise only in stories. */
  readonly workshop?: boolean
  /** The chat panel tab where this is set, and what its link is called. */
  readonly open?: { readonly panel: string; readonly label: string }
  readonly initial: S
  // Methods, so a kind with a state of its own is held as a `StateMarkerKind` by the registry,
  // which only ever hands a kind the states that kind made.
  step(state: S, event: StateMarkEvent, context: MarkContext): S
  /** What changed between two states, a message's events apart; empty for nothing. */
  changes(before: S, after: S, context: MarkContext): ReadonlyArray<StateChange>
}

export const stateMarkerKinds = {
  id: "chat.state-marker-kinds",
  ...makeRegistry<StateMarkerKind>()
}

/** A position's changes of one kind. */
export interface StateMark {
  readonly kind: string
  readonly open?: StateMarkerKind["open"]
  readonly changes: ReadonlyArray<StateChange>
}

/**
 * The marks by the message they sit under. Events before the first message are where the chat
 * started: they're folded and mark nothing.
 */
export const marksOf = (
  data: StateMarks,
  kinds: ReadonlyArray<StateMarkerKind>
): ReadonlyMap<string, ReadonlyArray<StateMark>> => {
  const context: MarkContext = {
    name: (id) => (id == null ? null : (data.names[id] ?? null)),
    notes: data.notes
  }
  const bySlot = new Map<string, Array<StateMark>>()
  for (const kind of [...kinds].sort((a, b) => a.order - b.order)) {
    const keys = new Set(kind.keys)
    let state = kind.initial
    let before = state
    let slot: SlotId | null = null
    const close = () => {
      if (slot === null) return
      const changes = kind.changes(before, state, context)
      if (changes.length === 0) return
      const list = bySlot.get(slot) ?? []
      list.push({ kind: kind.id, ...(kind.open ? { open: kind.open } : {}), changes })
      bySlot.set(slot, list)
    }
    for (const event of data.events) {
      if (!keys.has(event.key)) continue
      if (event.slotId !== slot) {
        close()
        slot = event.slotId
        before = state
      }
      state = kind.step(state, event, context)
    }
    close()
  }
  return bySlot
}

// --- The built-in kinds

const chatState = { initial: foldState([]) }
/** A kind that folds the chat state itself, as the assembler does. */
const folded = (kind: Omit<StateMarkerKind<ChatState>, "initial" | "step" | "source">): StateMarkerKind<ChatState> => ({
  ...kind,
  source: import.meta.url,
  initial: chatState.initial,
  step: (state, event) =>
    foldState([{ scope: event.scope, data: { key: event.key, value: event.value } } as never], state)
})

const list = (names: ReadonlyArray<string>) => names.join(", ")
const onOff = (on: boolean) => (on ? "on" : "off")
const NEXT = "From the next reply on"

const castKind = folded({
  id: "state.cast",
  order: 10,
  label: "Who joined or left",
  description:
    "Under the message after which a character was added to the chat or removed, or you began playing someone else.",
  keys: ["participant.join", "participant.leave", "played_by_me.set", "cast.role"],
  open: { panel: "cast", label: "Cast" },
  changes: (before, after, { name }) => {
    const changes: Array<StateChange> = []
    const persona = after.playedByMe.at(-1) ?? null
    const was = before.playedByMe.at(-1) ?? null
    const switched = persona !== was
    if (switched && persona === null && name(was) !== null) {
      changes.push({
        id: "persona",
        text: `You no longer play ${name(was)}`,
        explanation: `${NEXT}, what you write has no character card of yours.`
      })
    }
    if (switched && name(persona) !== null) {
      const from = name(was)
      changes.push({
        id: "persona",
        text: from === null ? `You play ${name(persona)}` : `You play ${name(persona)} (was ${from})`,
        explanation: `${NEXT}, what you write is ${name(persona)}'s, and ${name(persona)}'s card is the one sent as yours.`
      })
    }
    for (const id of after.participants) {
      if (before.participants.includes(id) || (switched && id === persona) || name(id) === null) continue
      changes.push({
        id: `join:${id}`,
        text: `${name(id)} joined`,
        explanation: `${NEXT}, ${name(id)} is in the chat: ${name(id)}'s card is sent to the model.`
      })
    }
    for (const id of before.participants) {
      if (after.participants.includes(id) || (switched && id === was) || name(id) === null) continue
      changes.push({
        id: `leave:${id}`,
        text: `${name(id)} was removed`,
        explanation: `${NEXT}, ${name(id)} isn't in the chat: ${name(id)}'s card is no longer sent and ${name(id)} doesn't reply. Earlier messages stay.`
      })
    }
    for (const id of new Set([...Object.keys(before.roles), ...Object.keys(after.roles)])) {
      if (before.roles[id] === after.roles[id] || name(id) === null) continue
      const narrator = after.roles[id] === "narrator"
      changes.push({
        id: `role:${id}`,
        text: narrator ? `${name(id)} became the narrator` : `${name(id)} is no longer the narrator`,
        explanation: narrator
          ? `${NEXT}, ${name(id)} narrates: sees everything and is never away from the scene.`
          : `${NEXT}, ${name(id)} is an ordinary character again.`
      })
    }
    return changes
  }
})

const muteKind = folded({
  id: "state.mute",
  order: 20,
  label: "Who was muted",
  description: "Under the message after which a character was muted or unmuted.",
  keys: ["participant.join", "participant.leave", "presence.set"],
  open: { panel: "cast", label: "Cast" },
  changes: (before, after, { name }) =>
    [...new Set([...before.absent, ...after.absent])].flatMap((id): Array<StateChange> => {
      const muted = after.absent.includes(id)
      // A departing character no longer needs a mute marker. A newly joined, muted one does.
      if (muted === before.absent.includes(id) || !after.participants.includes(id)) return []
      if (name(id) === null) return []
      return [
        {
          id: `mute:${id}`,
          text: muted ? `${name(id)} muted` : `${name(id)} unmuted`,
          explanation: muted
            ? `${NEXT}, ${name(id)} isn't picked to reply. ${name(id)} is still there and still sent to the model.`
            : `${NEXT}, ${name(id)} can be picked to reply again.`
        }
      ]
    })
})

/** Each note's last switch, and each moved group's: a note without one keeps its default. */
interface NoteSwitches {
  readonly notes: ReadonlyMap<string, boolean>
  readonly groups: ReadonlyMap<string, boolean>
}
const groupOf = (context: MarkContext, note: string) => {
  const about = context.notes[note]
  return about && about.card !== null && about.group !== null ? JSON.stringify([about.card, about.group]) : null
}
const noteOn = (switches: NoteSwitches, context: MarkContext, note: string) => {
  const group = groupOf(context, note)
  const grouped = group === null ? undefined : switches.groups.get(group)
  return grouped ?? switches.notes.get(note) ?? context.notes[note]?.onByDefault ?? false
}

const notesKind: StateMarkerKind<NoteSwitches> = {
  id: "state.notes",
  source: import.meta.url,
  order: 30,
  label: "Notes switched on or off",
  description: "Under the message after which a note began or stopped being sent, a character's notes included.",
  keys: ["note.activate", "note.deactivate"],
  open: { panel: "notes", label: "Notes" },
  initial: { notes: new Map(), groups: new Map() },
  step: (state, event, context) => {
    const note = (event.value as { readonly note?: unknown } | null)?.note
    if (typeof note !== "string") return state
    const on = event.key === "note.activate"
    const group = groupOf(context, note)
    return group === null
      ? { ...state, notes: new Map(state.notes).set(note, on) }
      : { ...state, groups: new Map(state.groups).set(group, on) }
  },
  changes: (before, after, context) => {
    const on: Array<string> = []
    const off: Array<string> = []
    for (const note of Object.keys(context.notes)) {
      const now = noteOn(after, context, note)
      const name = context.name(note)
      if (now === noteOn(before, context, note) || name === null) continue
      ;(now ? on : off).push(name)
    }
    return [
      ...(on.length > 0
        ? [
            {
              id: "on",
              text: `${on.length === 1 ? "Note" : "Notes"} on: ${list(on)}`,
              explanation: `${NEXT}, ${on.length === 1 ? "this note is" : "these notes are"} sent to the model where ${on.length === 1 ? "it says" : "they say"}.`
            }
          ]
        : []),
      ...(off.length > 0
        ? [
            {
              id: "off",
              text: `${off.length === 1 ? "Note" : "Notes"} off: ${list(off)}`,
              explanation: `${NEXT}, ${off.length === 1 ? "this note is" : "these notes are"} no longer sent to the model.`
            }
          ]
        : [])
    ]
  }
}

const ROLE_OF: Readonly<Record<string, string>> = { narrator: "the narrator", summarizer: "summaries" }
/** Whose a binding is, after "Model" or "Prompt preset": "", " for the narrator", " for Wren". */
const forWhom = (scope: string, name: MarkContext["name"]) =>
  scope === "" ? "" : ` for ${ROLE_OF[scope] ?? name(scope) ?? "a character"}`

/** A binding per scope, as "Model: A → B", "Model for this chat: A", "Model: your usual one again (was A)". */
const bindingChanges = (
  what: string,
  usual: string,
  before: Readonly<Record<string, string | null>>,
  after: Readonly<Record<string, string | null>>,
  name: MarkContext["name"],
  sameBinding: (scope: string) => boolean,
  includingRegenerated = false
): Array<StateChange> =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((scope): Array<StateChange> => {
    const was = before[scope]
    const now = after[scope]
    if (sameBinding(scope)) return []
    // Something named was deleted for good: nothing true can be said.
    if (was === null || now === null) return []
    const label = `${what}${forWhom(scope, name)}`
    const whose = scope === "" ? "replies in this chat" : `replies${forWhom(scope, name)}`
    const text =
      was === undefined
        ? `${label} set for this chat: ${now}`
        : now === undefined
          ? `${label}: ${usual} again (was ${was})`
          : was === now
            ? `${label} changed: ${now}`
            : `${label}: ${was} → ${now}`
    return [
      {
        id: `${what}:${scope}`,
        text: includingRegenerated ? `${text} · new and regenerated replies` : text,
        explanation: includingRegenerated
          ? `From now on, new and regenerated ${whose} use ${now ?? usual}.`
          : now === undefined
            ? `${NEXT}, ${whose} follow ${usual} again instead of one kept for this chat.`
            : `${NEXT}, ${whose} use ${now}, whatever ${usual} is.`
      }
    ]
  })

const modelKind = folded({
  id: "state.model",
  order: 40,
  label: "This chat's model changed",
  description:
    "Where the model selected for new and regenerated replies changed. Each reply's own model shows in its header.",
  keys: ["model.binding", "model.unbind"],
  workshop: true,
  open: { panel: "model", label: "Model" },
  changes: (before, after, { name }) => {
    const named = (bindings: ChatState["modelBindings"]) =>
      Object.fromEntries(
        Object.entries(bindings).map(([scope, binding]) => {
          const model = name(binding.model)
          const connection = name(binding.connection)
          return [scope, model === null ? null : connection === null ? model : `${connection} · ${model}`]
        })
      )
    return bindingChanges(
      "Model",
      "your usual model",
      named(before.modelBindings),
      named(after.modelBindings),
      name,
      (scope) =>
        before.modelBindings[scope]?.connection === after.modelBindings[scope]?.connection &&
        before.modelBindings[scope]?.model === after.modelBindings[scope]?.model,
      true
    )
  }
})

const presetKind = folded({
  id: "state.preset",
  order: 50,
  label: "This chat's preset changed",
  description: "Under the message after which a prompt preset kept for this chat was set, changed or dropped.",
  keys: ["preset.binding", "preset.unbind", "preset_overlay.binding"],
  workshop: true,
  open: { panel: "preset", label: "Prompt preset" },
  changes: (before, after, { name }) => {
    const named = (bindings: ChatState["presetBindings"]) =>
      Object.fromEntries(
        Object.entries(bindings).map(([scope, binding]) => [
          scope,
          binding.ref === undefined ? "the built-in preset" : name(binding.ref)
        ])
      )
    const overlays = [
      ...new Set([...Object.keys(before.presetOverlays), ...Object.keys(after.presetOverlays)])
    ].flatMap((id): Array<StateChange> => {
      const on = after.presetOverlays[id] ?? false
      if (on === (before.presetOverlays[id] ?? false) || name(id) === null) return []
      return [
        {
          id: `overlay:${id}`,
          text: `Preset add-on ${onOff(on)}: ${name(id)}`,
          explanation: on
            ? `${NEXT}, this add-on changes the preset the model is sent.`
            : `${NEXT}, this add-on no longer changes the preset.`
        }
      ]
    })
    return [
      ...bindingChanges(
        "Prompt preset",
        "your usual preset",
        named(before.presetBindings),
        named(after.presetBindings),
        name,
        (scope) =>
          before.presetBindings[scope]?.ref === after.presetBindings[scope]?.ref &&
          before.presetBindings[scope]?.revision === after.presetBindings[scope]?.revision &&
          scope in before.presetBindings === scope in after.presetBindings
      ),
      ...overlays
    ]
  }
})

const lorebookKind = folded({
  id: "state.lorebooks",
  order: 60,
  label: "Lorebooks switched on or off",
  description: "Under the message after which a lorebook was added to the chat, turned on or off, or taken out.",
  keys: ["lorebook.attach", "lorebook.detach", "lorebook.remove", "lorebook.embedded"],
  open: { panel: "lorebooks", label: "Lorebooks" },
  changes: (before, after, { name }) => {
    const changes: Array<StateChange> = []
    const refs = new Set([...before.listedLorebooks, ...after.listedLorebooks].map((book) => book.ref))
    for (const ref of refs) {
      const was = before.lorebooks.includes(ref)
      const now = after.lorebooks.includes(ref)
      if (was === now || name(ref) === null) continue
      changes.push({
        id: `book:${ref}`,
        text: `Lorebook ${onOff(now)}: ${name(ref)}`,
        explanation: now
          ? `${NEXT}, this lorebook's entries are sent when they match.`
          : `${NEXT}, this lorebook's entries are no longer sent.`
      })
    }
    for (const id of new Set([...Object.keys(before.embeddedLorebooks), ...Object.keys(after.embeddedLorebooks)])) {
      const was = before.embeddedLorebooks[id] ?? true
      const now = after.embeddedLorebooks[id] ?? true
      if (was === now || name(id) === null) continue
      changes.push({
        id: `embedded:${id}`,
        text: `${name(id)}'s own lorebook ${onOff(now)}`,
        explanation: now
          ? `${NEXT}, the lorebook inside ${name(id)}'s card is used.`
          : `${NEXT}, the lorebook inside ${name(id)}'s card is left out.`
      })
    }
    return changes
  }
})

const WORDS: Readonly<Record<string, string>> = {
  shared: "one shared",
  separate: "separate per character",
  by_writer: "by who wrote it",
  alternate: "alternating",
  perspective: "from the speaker's side",
  parallel: "alongside",
  join: "at the join",
  natural: "natural order",
  list: "list order",
  pooled: "pooled",
  manual: "only when picked",
  as_written: "as written",
  text: "text only",
  panels: "without panels"
}
const word = (value: string) => WORDS[value] ?? value
const depthWords = (depth: NonNullable<ChatState["htmlDepth"]>) =>
  depth.mode === "as_written" ? word(depth.mode) : `${word(depth.mode)}, older than ${depth.n}`

/** A chat setting that changes requests: its name, its value in words, and what its change means. */
const SETTINGS: ReadonlyArray<{
  readonly id: string
  readonly label: string
  readonly value: (state: ChatState) => string
  readonly explanation: string
}> = [
  {
    id: "context",
    label: "Context",
    value: (state) => word(state.contextPerSpeaker ?? "shared"),
    explanation: `${NEXT}, each reply sees either everything, or only what its speaker was there for.`
  },
  {
    id: "card-swap",
    label: "Card swap",
    value: (state) => onOff(state.cardsRotation ?? false),
    explanation: `${NEXT}, either every character's card is sent, or only the replying character's.`
  },
  {
    id: "tools",
    label: "Tools",
    value: (state) => onOff(state.agentEnabled ?? false),
    explanation: `${NEXT}, replies are written with or without tools and their instructions.`
  },
  {
    id: "roles",
    label: "Message roles",
    value: (state) => word(state.rolesProjection ?? "by_writer"),
    explanation: `${NEXT}, earlier messages reach the model in these roles.`
  },
  {
    id: "merged",
    label: "Merged chats",
    value: (state) => word(state.mergeLayout ?? "parallel"),
    explanation: `${NEXT}, the messages of chats merged into this one are placed this way for the model.`
  },
  {
    id: "html",
    label: "HTML in older messages",
    value: (state) => depthWords(state.htmlDepth ?? { mode: "as_written", n: 4 }),
    explanation: `${NEXT}, older messages' HTML is sent to the model this way.`
  },
  {
    id: "lore-below",
    label: "Lorebook entries below the history",
    value: (state) => onOff(state.loreBelowHistory ?? true),
    explanation: `${NEXT}, lorebook entries go either only below the history, or where each says.`
  },
  {
    id: "reply-order",
    label: "Who replies",
    value: (state) => word(state.replyOrder ?? "natural"),
    explanation: `${NEXT}, this decides who replies when nobody is picked.`
  },
  {
    id: "reply-single",
    label: "One reply at a time",
    value: (state) => onOff(state.replySingle ?? false),
    explanation: `${NEXT}, a message gets either one reply or a whole round of them.`
  }
]

const settingsKind = folded({
  id: "state.settings",
  order: 70,
  label: "Chat settings changed",
  description:
    "Under the message after which a setting of this chat that changes what the model is sent, or who replies, was changed.",
  keys: [
    "context.per_speaker",
    "cards.rotation",
    "agent.enabled",
    "roles.projection",
    "merge.layout",
    "context.html_depth",
    "lorebook.below_history",
    "reply.order",
    "reply.single"
  ],
  open: { panel: "chat", label: "This chat" },
  changes: (before, after) =>
    SETTINGS.flatMap((setting): Array<StateChange> => {
      const was = setting.value(before)
      const now = setting.value(after)
      return was === now
        ? []
        : [{ id: setting.id, text: `${setting.label}: ${was} → ${now}`, explanation: setting.explanation }]
    })
})

export const registerStateMarkerKinds = () =>
  [castKind, muteKind, notesKind, modelKind, presetKind, lorebookKind, settingsKind].map((kind) =>
    stateMarkerKinds.register(kind)
  )

// --- One session's marks

type Key = {
  readonly forkId: ForkId
  readonly leaf: SlotId | null
  readonly generation: number
  readonly kinds: unknown
}
const EMPTY: ReadonlyArray<StateMark> = []

/** Read again when the branch, its leaf, the chat's state or the registered kinds change. */
class StateMarksStore {
  private marks: ReadonlyMap<string, ReadonlyArray<StateMark>> = new Map()
  private key: Key | null = null
  private readonly listeners = new Set<() => void>()
  private unsubscribe: Array<() => void> = []
  /** The rows the user opened, by message: kept while its row is scrolled away, so heights hold. */
  readonly open = new Set<string>()

  private readonly session: ChatSession
  constructor(session: ChatSession) {
    this.session = session
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1) {
      this.unsubscribe = [
        this.session.subscribe(() => this.check()),
        this.session.subscribePositions(() => this.check()),
        stateMarkerKinds.subscribe(() => this.check())
      ]
      this.check()
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) for (const stop of this.unsubscribe.splice(0)) stop()
    }
  }

  readonly at = (slotId: SlotId) =>
    this.key?.forkId === this.session.snapshot().forkId ? (this.marks.get(slotId) ?? EMPTY) : EMPTY

  private check() {
    const view = this.session.snapshot()
    if (view.forkId === null || view.loading) return
    const kinds = stateMarkerKinds.snapshot().entries
    // Positional readers also notify when cached cast/card text arrives while scrolling.
    // Only invalidation or a changed path affects marks, not those cache fills.
    const key: Key = {
      forkId: view.forkId,
      leaf: view.leafSlotId,
      generation: this.session.positionRevision + view.pathRevision,
      kinds
    }
    if (
      this.key &&
      this.key.forkId === key.forkId &&
      this.key.leaf === key.leaf &&
      this.key.generation === key.generation &&
      this.key.kinds === kinds
    )
      return
    const switched = this.key?.forkId !== key.forkId
    this.key = key
    if (switched) this.publish(new Map())
    void this.read(key, kinds)
  }

  private async read(key: Key, kinds: ReadonlyArray<StateMarkerKind>) {
    const keys = [...new Set(kinds.flatMap((kind) => kind.keys))]
    if (keys.length === 0) return this.publish(new Map())
    const result = await this.session.call((client) =>
      client("GetStateMarks", { chatId: this.session.id, forkId: key.forkId, slotId: key.leaf, keys })
    )
    if (this.key !== key || !result.ok) return
    this.publish(marksOf(result.value, kinds))
  }

  private publish(marks: ReadonlyMap<string, ReadonlyArray<StateMark>>) {
    this.marks = marks
    for (const listener of this.listeners) listener()
  }
}

const stores = new WeakMap<ChatSession, StateMarksStore>()

export const stateMarksOf = (session: ChatSession) => {
  let store = stores.get(session)
  if (!store) {
    store = new StateMarksStore(session)
    stores.set(session, store)
  }
  return store
}
