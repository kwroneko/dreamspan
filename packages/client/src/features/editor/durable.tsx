// Typed text is never lost (ARCHITECTURE §3.10 invariant 1): the one way a text box that has
// no draft store of its own (a library field's EditorStore, a message's MessageDraft, the
// composer's ComposerDraft…) keeps what's typed. Each is a private `user_field` workspace
// (userDraft.tsx): saved to the server as it's typed, kept in this browser until the server
// has it, and read back when the box opens again. A box names its workspace with a key
// unique to what it edits ("network", "mcp:<id>", "approval-note:<id>"); a form of several
// fields keeps them together as one JSON snapshot, so undo and recovery bring back the whole
// form. Save ends the workspace with the text it saved (`commit`); Cancel ends it with the
// text still recoverable from the bin (`discard`).
//
// What was open, a dialog or a disclosure the box is in, is URL state (`useOpenPlace`), like
// the app's other views: a reload opens it again, and the box in it reads its text back.
import { useRouter } from "@tanstack/react-router"
import { type ComponentProps, useCallback, useEffect } from "react"
import { usePlaceOwner } from "../../placeOwner.tsx"
import type { DurableFields, DurableText } from "../../ui/durableFields.tsx"
import { usePlaceList, writePlaceValue } from "../../usePlaceParam.ts"
import { UserDraftRefused, useUserDraft } from "./userDraft.tsx"

/** One text kept as typed under `key`; `saved` is the text it starts from. */
export function useDurableText(key: string, field: string, saved: string) {
  const draft = useUserDraft(key, field, saved)
  return {
    text: draft.text,
    /** Until the server's text is read, typing would race it: the box is read-only. */
    ready: draft.ready,
    setText: draft.setText,
    /** Runs `save` with the text, and ends the workspace when it succeeds. */
    commit: (save: (text: string) => Promise<boolean>) => draft.commit(draft.text, () => save(draft.text)),
    /** Ends the workspace without saving: the text stays recoverable in the bin. Untouched text ends nothing. */
    discard: () => (draft.text === saved ? Promise.resolve(true) : draft.discard()),
    draft
  }
}

const parse = <T extends object>(text: string, saved: T): T => {
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === "object" && !Array.isArray(value) ? { ...saved, ...(value as T) } : saved
  } catch {
    return saved
  }
}

/** A form of several fields kept as typed under `key`, as one snapshot; `saved` is what it starts from. */
export function useDurableForm<T extends object>(key: string, field: string, saved: T) {
  const draft = useUserDraft(key, field, JSON.stringify(saved))
  const values = parse(draft.text, saved)
  return {
    values,
    ready: draft.ready,
    edit: (change: Partial<T>) => draft.setText(JSON.stringify({ ...values, ...change })),
    replace: (next: T) => draft.setText(JSON.stringify(next)),
    /** Runs `save` with the values, and ends the workspace when it succeeds. */
    commit: (save: (values: T) => Promise<boolean>) => draft.commit(draft.text, () => save(values)),
    /** Ends the workspace without saving: the text stays recoverable in the bin. An untouched form ends nothing. */
    discard: () => (draft.text === JSON.stringify(saved) ? Promise.resolve(true) : draft.discard()),
    /**
     * "Use this tab's version" while this tab's form was refused as out of date (owner,
     * 2026-11-24), nothing otherwise. Dialogs put it before Cancel in their horizontal Save
     * row, which puts it last when DialogActions stacks the buttons on a phone.
     */
    refusedAction: <UserDraftRefused draft={draft} />,
    draft
  }
}

/**
 * While `id` is open, if the component unmounts because the registered entry it belongs to
 * went away (placeOwner.tsx), takes `id` out of the URL: restoring the entry doesn't reopen
 * it. A reload or leaving the page keeps it (the entry is still there), so a reload reopens
 * it; what was typed stays in its draft either way.
 */
function useDropWithOwner(id: string | undefined) {
  const owner = usePlaceOwner()
  const router = useRouter()
  useEffect(() => {
    if (id === undefined || owner === null) return
    return () => {
      if (owner.present()) return
      writePlaceValue(router, "open", (current) => {
        if (!Array.isArray(current)) return current
        const next = current.filter((other) => other !== id)
        return next.length ? next : undefined
      })
    }
  }, [id, owner, router])
}

/**
 * Whether the dialog, editor or disclosure `id` is open, kept in the URL (`open`), so a
 * reload opens it again. Several can be open at once; ids name what they open
 * ("new-card", "rename-key:<id>"). It closes when the registered entry it's under goes away.
 */
export function useOpenPlace(id: string) {
  const [open, setOpen] = usePlaceList("open")
  const shown = open.includes(id)
  useDropWithOwner(shown ? id : undefined)
  const set = useCallback(
    (next: boolean) => {
      if (next === shown) return
      setOpen(next ? [...open, id] : open.filter((other) => other !== id), true)
    },
    [open, id, shown, setOpen]
  )
  return [shown, set] as const
}

/**
 * One of several things open at a time under `prefix` (the row being renamed, which new
 * item's form is open), kept as `<prefix><choice>` in the same URL list; null: none.
 */
export function useOpenChoice(prefix: string) {
  const [open, setOpen] = usePlaceList("open")
  const id = open.find((other) => other.startsWith(prefix))
  useDropWithOwner(id)
  const set = useCallback(
    (next: string | null) => {
      const choice = next === null ? undefined : `${prefix}${next}`
      if (choice === id) return
      setOpen([...open.filter((other) => other !== id), ...(choice ? [choice] : [])], true)
    },
    [open, id, prefix, setOpen]
  )
  return [id === undefined ? null : id.slice(prefix.length), set] as const
}

/** A disclosure whose open state is URL state (`useOpenPlace(place)`), so a reload opens it again. */
export function PlaceDetails({ place, ...props }: ComponentProps<"details"> & { place: string }) {
  const [open, setOpen] = useOpenPlace(place)
  return <details {...props} open={open} onToggle={(event) => setOpen(event.currentTarget.open)} />
}

function useAppText(key: string, field: string, saved: string): DurableText {
  const durable = useDurableText(key, field, saved)
  return {
    text: durable.text,
    ready: durable.ready,
    setText: durable.setText,
    commit: () => void durable.commit(async () => true),
    discard: () => void durable.discard()
  }
}

/** The UI's own text boxes (ui/durableFields.tsx), kept as the app's are; the shell provides it. */
export const appDurableFields: DurableFields = { useText: useAppText, useOpen: useOpenPlace }
