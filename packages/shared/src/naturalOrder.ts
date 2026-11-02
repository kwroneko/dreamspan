// ST's natural order for group replies (public/scripts/group-chats.js `activateNaturalOrder`),
// made deterministic: the rolls come from a PRNG seeded by the caller, so the same chat state
// gives the same pick wherever it's computed (DESIGN §2.3).

/** ST's `talkativeness_default`: a card's chance to reply when it sets none. */
export const TALKATIVENESS_DEFAULT = 0.5

/**
 * A card's `extensions.talkativeness` as a chance 0..1. ST stores it as a number or a numeric
 * string; anything else (absent, empty, NaN) is the default.
 */
export const talkativenessOf = (value: unknown): number => {
  const n =
    typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : TALKATIVENESS_DEFAULT
}

/** A 32-bit FNV-1a hash of the strings, each ended by a separator. */
export const hashSeed = (parts: ReadonlyArray<string>): number => {
  let h = 0x811c9dc5
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      h ^= part.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    h ^= 0x1f
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32: a small seeded PRNG giving numbers in [0, 1). */
export const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Lowercased words of a text (ST's `extractAllWords`, with letters beyond ASCII too). */
const wordsOf = (text: string): Array<string> =>
  Array.from(text.toLowerCase().matchAll(/[\p{L}\p{N}_]+/gu), (m) => m[0])

export interface NaturalMember<Id> {
  readonly id: Id
  readonly name: string
  /** 0..1. */
  readonly talkativeness: number
}

/**
 * Who ST's natural order activates, in order: members named in `input` (by a whole word of
 * their name, in the order the words come), then, in a shuffled order, each member whose roll
 * is at most their talkativeness; when no one is activated, one random pick among the chatty
 * (talkativeness above 0), or among everyone else when no one is. `banned` (the last character
 * to speak, when no one typed) is skipped by the mentions and the rolls, as in ST, and is picked
 * only when they're the only member.
 */
export const naturalOrder = <Id>(
  members: ReadonlyArray<NaturalMember<Id>>,
  input: string,
  banned: Id | null,
  random: () => number
): Array<Id> => {
  const activated: Array<Id> = []
  const add = (id: Id) => {
    if (!activated.includes(id)) activated.push(id)
  }
  const names = members.map((m) => wordsOf(m.name))
  for (const word of wordsOf(input)) {
    const index = members.findIndex((m, i) => m.id !== banned && names[i]!.includes(word))
    if (index >= 0) add(members[index]!.id)
  }
  // Fisher-Yates, as ST's `shuffle`.
  const shuffled = [...members]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
  }
  const chatty: Array<Id> = []
  for (const member of shuffled) {
    if (member.id === banned) continue
    // ST rolls `talkativeness >= Math.random()`; a talkativeness of 0 never passes here.
    const roll = random()
    if (member.talkativeness > 0 && member.talkativeness >= roll) add(member.id)
    if (member.talkativeness > 0) chatty.push(member.id)
  }
  if (activated.length === 0 && members.length > 0) {
    // ST falls back to every member, the banned one too; here they answer themselves only when
    // no one else can.
    const others = members.filter((m) => m.id !== banned).map((m) => m.id)
    const pool = chatty.length > 0 ? chatty : others.length > 0 ? others : members.map((m) => m.id)
    add(pool[Math.floor(random() * pool.length)]!)
  }
  return activated
}

// ST's other group reply strategies (`group_activation_strategy` in group-chats.js). ST runs the
// whole activated list in turn, as a round does here (`replyPolicy.ts`); these picks are for one
// reply at a time, the Cast tab's switch (DESIGN §2.3).

/** ST's reply strategies by their `activation_strategy` number, as policy ids (`replyPolicy.ts`). */
export const ST_REPLY_ORDERS: Readonly<Record<number, string>> = { 0: "natural", 1: "list", 2: "manual", 3: "pooled" }

/**
 * ST's list order (`activateListOrder`, every member in the group's order), one reply at a time:
 * the first member after `last` in `order`, the one to reply last since the user's turn; the first
 * member when no one has yet, or after the last member. `members` are those who can reply, in `order`.
 */
export const listOrder = <Id>(order: ReadonlyArray<Id>, members: ReadonlyArray<Id>, last: Id | null): Id | null => {
  if (members.length === 0) return null
  const from = last === null ? -1 : order.indexOf(last)
  if (from < 0) return members[0]!
  return members.find((id) => order.indexOf(id) > from) ?? members[0]!
}

/**
 * ST's pooled order (`activatePooledOrder`): one member at random among those who haven't spoken
 * since the user's turn (`spoke`); when all have, among everyone but `last`, the last to speak,
 * unless they're the only member.
 */
export const pooledOrder = <Id>(
  members: ReadonlyArray<Id>,
  spoke: ReadonlyArray<Id>,
  last: Id | null,
  random: () => number
): Id | null => {
  const fresh = members.filter((id) => !spoke.includes(id))
  const pool =
    fresh.length > 0 ? fresh : last !== null && members.length > 1 ? members.filter((id) => id !== last) : [...members]
  return pool.length === 0 ? null : pool[Math.floor(random() * pool.length)]!
}

/**
 * ST's manual order: nobody replies to a message you send (you pick who does); asked for a reply
 * with nothing sent (ST's empty send, here Reply now or an empty Send), one member at random.
 */
export const manualOrder = <Id>(members: ReadonlyArray<Id>, typed: boolean, random: () => number): Id | null =>
  typed || members.length === 0 ? null : members[Math.floor(random() * members.length)]!
