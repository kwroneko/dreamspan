// Which regex scripts a message's display runs (ARCHITECTURE §10, "Opt-in display
// transformations"): the registered lists, by default the account's global scripts, then the
// preset's, then the message's character's, as ST 1.19 orders them. Global scripts are the user's own and always run; the
// preset's and a card's only once the user allowed them (`regex_approved`). The display
// runner then keeps only enabled `markdown_only` ones for the placement (with `prompt_only` too, they run in
// both, as in ST).
import type { Cast } from "@rp/shared/chatSetupApi.ts"
import type { EntityId } from "@rp/shared/chat.ts"
import type { Doc, RefId } from "@rp/shared/library.ts"
import type { RegexScript } from "@rp/shared/docs/regexScript.ts"
import { makeRegistry } from "../../registry.ts"

const NONE: ReadonlyArray<RegexScript> = []

/** A preset's or card's scripts, only when it allows them. */
export const approvedScripts = (doc: Doc | null | undefined): ReadonlyArray<RegexScript> =>
  doc?.regex_approved === true && Array.isArray(doc.regex) ? (doc.regex as ReadonlyArray<RegexScript>) : NONE

/**
 * The character whose scripts apply to a message: on the model's side, its speaker; on the
 * user's side (or a reply with no recorded speaker), the chat's only character the user
 * doesn't play, when there's exactly one.
 */
export const messageCharacter = (
  cast: Pick<Cast, "participants" | "playedByMe"> | null,
  speaker: EntityId | null,
  placement: 1 | 2
): EntityId | null => {
  if (placement === 2 && speaker !== null) return speaker
  const others = (cast?.participants ?? []).filter((id) => !cast!.playedByMe.includes(id))
  return others.length === 1 ? others[0]! : null
}

/** What a display script list reads for one text: the chat's lists and the message's character's. */
export interface DisplayListContext {
  readonly global: ReadonlyArray<RegexScript>
  /** The preset's, once it allows them. */
  readonly preset: ReadonlyArray<RegexScript>
  /** The message's character's (`messageCharacter`), once its card allows them. */
  readonly character: ReadonlyArray<RegexScript>
  readonly characterId: EntityId | null
  /** ST's placement of the text: 1 user input, 2 AI output, 6 reasoning. */
  readonly placement: number
}

/** A list of scripts a message's display runs (the `displayScriptLists` registry), by order. */
export interface DisplayScriptList {
  readonly id: string
  readonly order: number
  readonly scripts: (context: DisplayListContext) => ReadonlyArray<RegexScript>
}

export const displayScriptLists = makeRegistry<DisplayScriptList>()

/** ST 1.19's three lists, in its order. */
export const builtinDisplayScriptLists: ReadonlyArray<DisplayScriptList> = [
  { id: "display-regex.global", order: 10, scripts: (context) => context.global },
  { id: "display-regex.preset", order: 20, scripts: (context) => context.preset },
  { id: "display-regex.character", order: 30, scripts: (context) => context.character }
]

const contentKeys = new WeakMap<ReadonlyArray<RegexScript>, string>()
const contentKey = (scripts: ReadonlyArray<RegexScript>) => {
  let key = contentKeys.get(scripts)
  if (key === undefined) contentKeys.set(scripts, (key = JSON.stringify(scripts)))
  return key
}

/**
 * Whether two lists are the same scripts by content. A library refresh makes new objects for
 * the same scripts, so identity can't say whether a text came from the scripts now in effect.
 */
export const sameScripts = (a: ReadonlyArray<RegexScript>, b: ReadonlyArray<RegexScript>) =>
  a === b || contentKey(a) === contentKey(b)

/** The scripts of every list in effect, in order. */
export const displayScripts = (
  lists: ReadonlyArray<DisplayScriptList>,
  context: DisplayListContext
): ReadonlyArray<RegexScript> => {
  const scripts = [...lists].sort((a, b) => a.order - b.order).flatMap((list) => list.scripts(context))
  return scripts.length === 0 ? NONE : scripts
}

/** Whether a display transform would run any of these scripts on a text at this placement. */
export const displayRegexApplies = (scripts: ReadonlyArray<RegexScript>, placement: number) =>
  scripts.some((s) => !s.disabled && s.find_regex !== "" && s.markdown_only && s.placement.includes(placement))

/** A card's panel permissions (spec/HTML-MESSAGES.md §3.4), and the library entry they change in. */
export interface CardPanels {
  readonly refId: RefId
  readonly name: string
  readonly scripts: boolean
  readonly network: boolean
}

/** What a chat reads of a member's card for its display: approved scripts, panel permissions. */
export interface CardDisplay {
  readonly scripts: ReadonlyArray<RegexScript>
  readonly panels: CardPanels | null
}

/**
 * Cards' approved scripts and panel permissions by chat member, read with GetCardForChat (its
 * `regex` is present only when the card allows them). `refresh` reads them again after an
 * edit or approval elsewhere, keeping what was read until the new answer arrives; readers
 * re-render through `subscribe` only when a member's answer changed.
 */
export class CardScripts {
  private readonly known = new Map<EntityId, CardDisplay>()
  private readonly reading = new Map<EntityId, number>()
  private readonly listeners = new Set<() => void>()
  private generation = 0
  private readonly read: (entityId: EntityId) => Promise<CardDisplay | null>
  constructor(read: (entityId: EntityId) => Promise<CardDisplay | null>) {
    this.read = read
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** The member's approved scripts; none until read. */
  get(entityId: EntityId | null): ReadonlyArray<RegexScript> {
    if (entityId === null) return NONE
    if (!this.known.has(entityId) && !this.reading.has(entityId)) this.load(entityId)
    return this.known.get(entityId)?.scripts ?? NONE
  }

  /** The member's panel permissions; null until read, or for a card outside the library. */
  panels(entityId: EntityId | null): CardPanels | null {
    if (entityId === null) return null
    if (!this.known.has(entityId) && !this.reading.has(entityId)) this.load(entityId)
    return this.known.get(entityId)?.panels ?? null
  }

  readonly refresh = () => {
    this.generation++
    for (const entityId of new Set([...this.known.keys(), ...this.reading.keys()])) this.load(entityId)
  }

  private load(entityId: EntityId) {
    const generation = this.generation
    this.reading.set(entityId, generation)
    void this.read(entityId).then((read) => {
      // A newer read is on its way: this one still counts if nothing was read before, so
      // reads restarted again and again (context changes while a chat opens) still land.
      if (this.reading.get(entityId) !== generation && this.known.has(entityId)) return
      if (this.reading.get(entityId) === generation) this.reading.delete(entityId)
      // A card in the bin or gone runs none, as in assembly.
      const next: CardDisplay = {
        scripts: read && read.scripts.length > 0 ? read.scripts : NONE,
        panels: read?.panels ?? null
      }
      const previous = this.known.get(entityId)
      if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(next)) return
      this.known.set(entityId, next)
      for (const listener of this.listeners) listener()
    })
  }
}
