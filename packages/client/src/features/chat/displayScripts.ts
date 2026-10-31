// Which regex scripts a message's display runs (ARCHITECTURE §10, "Opt-in display
// transformations"): the account's global scripts, then the preset's, then the message's
// character's, as ST 1.19 orders them. Global scripts are the user's own and always run; the
// preset's and a card's only once the user allowed them (`regex_approved`). The display
// runner then keeps only enabled `markdown_only && !prompt_only` ones for the placement.
import type { Cast } from "@rp/shared/chatSetupApi.ts"
import type { EntityId } from "@rp/shared/chat.ts"
import type { Doc } from "@rp/shared/library.ts"
import type { RegexScript } from "@rp/shared/docs/regexScript.ts"

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

/** The ordered list: global, preset, then the character's (each already approved where it must be). */
export const displayScripts = (
  global: ReadonlyArray<RegexScript>,
  preset: ReadonlyArray<RegexScript>,
  character: ReadonlyArray<RegexScript>
): ReadonlyArray<RegexScript> =>
  global.length === 0 && preset.length === 0 && character.length === 0 ? NONE : [...global, ...preset, ...character]

/**
 * Cards' approved scripts by chat member, read with GetCardForChat (its `regex` is present
 * only when the card allows them). `refresh` reads them again after an edit or approval
 * elsewhere, keeping what was read until the new answer arrives; readers re-render through
 * `subscribe` only when a member's scripts changed.
 */
export class CardScripts {
  private readonly known = new Map<EntityId, ReadonlyArray<RegexScript>>()
  private readonly reading = new Map<EntityId, number>()
  private readonly listeners = new Set<() => void>()
  private generation = 0
  private readonly read: (entityId: EntityId) => Promise<ReadonlyArray<RegexScript> | null>
  constructor(read: (entityId: EntityId) => Promise<ReadonlyArray<RegexScript> | null>) {
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
    return this.known.get(entityId) ?? NONE
  }

  readonly refresh = () => {
    this.generation++
    for (const entityId of new Set([...this.known.keys(), ...this.reading.keys()])) this.load(entityId)
  }

  private load(entityId: EntityId) {
    const generation = this.generation
    this.reading.set(entityId, generation)
    void this.read(entityId).then((scripts) => {
      if (this.reading.get(entityId) !== generation) return
      this.reading.delete(entityId)
      // A card in the bin or gone runs none, as in assembly.
      const next = scripts && scripts.length > 0 ? scripts : NONE
      const previous = this.known.get(entityId)
      if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(next)) return
      this.known.set(entityId, next)
      for (const listener of this.listeners) listener()
    })
  }
}
