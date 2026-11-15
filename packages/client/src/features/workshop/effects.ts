// What a workshop run changed outside the chat (spec/WORKSHOP.md §3.6), as the step rows, the
// Changes tab and the regenerate warning show it: where each change opens, whether it can still be
// undone, and the undo itself. Apart from React, so it's tested on its own.
import type { RolloutEffect } from "@rp/shared/workshopApi.ts"
import { Atom } from "effect/reactivity"
import { AppClient } from "../../rpc.ts"

export type { RolloutEffect } from "@rp/shared/workshopApi.ts"

/** The Changes tab's id, and what a kind shows to have it and the step rows' Undo and Open. */
export const CHANGES = "workshop.changes"

/** Reactivity key of every list of changes: an undo reads them all again. */
export const EFFECTS_KEY = "rollout-effects"

/** The changes one reply's run made (its kept calls' too), newest first. */
export const versionEffectsAtom = Atom.family((versionId: string) =>
  AppClient.query("ListVersionEffects", { versionId }, { reactivityKeys: [EFFECTS_KEY, versionId] })
)

/** A change's identity, for keys and the undo. */
export const effectKey = (effect: RolloutEffect) => ({
  rolloutId: effect.rolloutId,
  toolCallId: effect.toolCallId,
  seq: effect.seq
})
export const effectId = (effect: RolloutEffect) => `${effect.rolloutId}:${effect.toolCallId}:${effect.seq}`

export type OpenTarget =
  | { readonly to: "/chats/$chatId"; readonly params: { readonly chatId: string } }
  | { readonly to: "/library/$refId"; readonly params: { readonly refId: string } }
  | { readonly to: "/cards/$entityId"; readonly params: { readonly entityId: string } }

/** Where a change opens: the chat it started, or the item it made or edited. */
export const openTarget = (effect: RolloutEffect): OpenTarget | null => {
  if (effect.targetKind === "chat") return { to: "/chats/$chatId", params: { chatId: effect.targetId } }
  if (effect.targetKind !== "entity") return null
  const refId = effect.undo?.refId
  return typeof refId === "string"
    ? { to: "/library/$refId", params: { refId } }
    : { to: "/cards/$entityId", params: { entityId: effect.targetId } }
}

/** What Open's hover says. */
export const openHint = (effect: RolloutEffect) =>
  effect.targetKind === "chat" ? "Opens the chat it started." : "Opens the item in its editor, with its history."

/** It can still be undone from here: the app kept how, and it isn't undone yet. */
export const undoable = (effect: RolloutEffect) => effect.undo !== null && effect.undoneAt === null

/** Changes still standing: what a new version of the reply wouldn't undo. */
export const outstanding = (effects: ReadonlyArray<RolloutEffect>) => effects.filter((e) => e.undoneAt === null)

/** "Undone", or nothing while it stands. */
export const effectState = (effect: RolloutEffect) => (effect.undoneAt === null ? null : "Undone")

/** Undo's hover: what it does to this kind of change. */
export const undoHint = (effect: RolloutEffect) =>
  effect.kind === "plugin.commit"
    ? "Creates a revert version without turning it on."
    : effect.kind === "plugin.write"
      ? "Restores the previous file text. The enabled version keeps running."
      : effect.kind === "plugin.enable"
        ? "Turns this plugin off and keeps its versions and data."
        : effect.kind === "plugin.create"
          ? "Turns this plugin off and keeps its repository and versions."
          : effect.kind === "chat.create"
            ? "Moves the chat it started to the bin."
            : effect.kind === "library.create"
              ? "Moves the item it made to the bin."
              : effect.kind === "library.revise"
                ? "Puts the item back as it was before, as a new revision."
                : effect.kind === "library.delete"
                  ? "Takes it back out of the bin."
                  : "Undoes this change."

/** Open is offered while the item is there to open: one in the bin (made and undone, or deleted) isn't. */
export const opensNow = (effect: RolloutEffect) =>
  effect.kind === "library.delete"
    ? effect.undoneAt !== null
    : !(effect.undoneAt !== null && effect.kind !== "library.revise")

/** The changes one reply's run made, as the Changes tab groups them. */
export interface ReplyChanges {
  readonly rolloutId: string
  /** Newest first, as listed. */
  readonly effects: ReadonlyArray<RolloutEffect>
  /** When its first change was made. */
  readonly startedAt: number
}

/**
 * Changes grouped by the reply that made them (its run), in the order the newest first list meets
 * them; pages read later join the group their reply already has.
 */
export const groupByReply = (rows: ReadonlyArray<RolloutEffect>): ReadonlyArray<ReplyChanges> => {
  const groups = new Map<string, Array<RolloutEffect>>()
  for (const row of rows) {
    const group = groups.get(row.rolloutId)
    if (group) group.push(row)
    else groups.set(row.rolloutId, [row])
  }
  return [...groups].map(([rolloutId, effects]) => ({
    rolloutId,
    effects,
    startedAt: Math.min(...effects.map((e) => e.createdAt))
  }))
}

/** "Undo all of this reply" is offered while any of its changes can still be undone. */
export const undoAllOffered = (group: ReplyChanges) => group.effects.some(undoable)
