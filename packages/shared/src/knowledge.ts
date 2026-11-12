// Who knows a message (spec/CHARACTER-CONTEXT.md §2.1, §9.1; DESIGN §7.1 [D], owner 2026-11-06:
// "When a message is generated, a certain set of characters is present ... Those characters can
// see the message"). Each version records the cast connected when it was written (`cast_json`,
// muted members included) and, apart from it, who of them was away and who was a narrator
// (`presence_json`). The pure rule lives here so assembly, the tools and the client agree on it.
import { Schema } from "effect"
import { EntityId } from "./chat.ts"
import type { ChatState } from "./state.ts"

/**
 * A version's presence record: who of its cast was away, and who was a narrator, when it was
 * written. Both absent (stored as NULL) when nobody was away and none was a narrator.
 */
export const VersionPresence = Schema.Struct({
  away: Schema.optionalKey(Schema.Array(EntityId)),
  narrators: Schema.optionalKey(Schema.Array(EntityId))
})
export type VersionPresence = typeof VersionPresence.Type

/**
 * The record a version written now takes, for its cast (`cast_json`'s ids) at the position:
 * the cast's away members (a narrator is never away) and its narrators, in cast order; null
 * when there's neither.
 */
export const presenceOf = (
  state: Pick<ChatState, "away" | "roles">,
  cast: ReadonlyArray<string>
): VersionPresence | null => {
  const narrators = cast.filter((id) => state.roles[id] === "narrator")
  const away = cast.filter((id) => state.away.includes(id) && state.roles[id] !== "narrator")
  if (away.length === 0 && narrators.length === 0) return null
  return {
    ...(away.length ? { away: away as Array<EntityId> } : {}),
    ...(narrators.length ? { narrators: narrators as Array<EntityId> } : {})
  }
}

/**
 * Who is away at the position (`away.set`), less narrators (§6: never in or out of the scene):
 * not picked to reply, by Auto or by Who replies next, as the muted aren't (§5).
 */
export const awayAt = (state: Pick<ChatState, "away" | "roles">): ReadonlyArray<string> =>
  state.away.filter((id) => state.roles[id] !== "narrator")

/**
 * [P] default for an open question (spec/CHARACTER-CONTEXT.md §9.3): whether an away character
 * counts as muted where a note's condition or a macro asks "not muted" (`{ when: "not_muted" }`,
 * `{{groupNotMuted}}`). True keeps what the scene check did when it wrote Mute: a note "while
 * Wren isn't muted" stops while she's away.
 */
export const AWAY_ACTS_AS_MUTED = true

/** What a version records about who was there, as read back from its row. */
export interface KnowledgeRecord {
  /** `cast_json`'s ids; null when the version has none recorded (known to everyone). */
  readonly cast: ReadonlyArray<string> | null
  readonly speaker: string | null
  readonly presence: VersionPresence | null
}

/**
 * The cards that know a version: its cast and its speaker, less those away when it was
 * written. A speaker always knows its own message. Null when no cast was recorded, which
 * counts as known to everyone.
 */
export const knowersOf = (record: KnowledgeRecord): ReadonlySet<string> | null => {
  if (record.cast === null) return null
  const away = new Set<string>(record.presence?.away ?? [])
  const knowers = new Set(record.cast.filter((id) => !away.has(id)))
  if (record.speaker !== null) knowers.add(record.speaker)
  return knowers
}

/** Whether a card knows a version: it was there when it was written, or nothing was recorded. */
export const knows = (viewer: string, record: KnowledgeRecord): boolean => knowersOf(record)?.has(viewer) ?? true

/** Reads a stored `presence_json`; anything that doesn't decode counts as nobody away. */
export const parsePresence = (json: string | null): VersionPresence | null => {
  if (json === null) return null
  try {
    const decoded = Schema.decodeUnknownOption(VersionPresence)(JSON.parse(json))
    return decoded._tag === "Some" ? decoded.value : null
  } catch {
    return null
  }
}

/**
 * A gap line's text when the preset has none (`utility_prompts.absent_gap_prompt`; §2.2 [D]):
 * `{{absentCount}}` is how many messages were left out, `{{absentNames}}` who was present then.
 */
export const ABSENT_GAP_DEFAULT =
  "[{{char}} wasn't present for {{absentCount}} messages here, in which {{absentNames}} took part.]"

/**
 * The line at a merge point whose storyline is new to the speaker (`utility_prompts.absent_join_prompt`):
 * empty by default, so nothing is sent (§2.2 [D]). `{{mergedNames}}` names the merged storyline's characters.
 */
export const ABSENT_JOIN_DEFAULT = ""
