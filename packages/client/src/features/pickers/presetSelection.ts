// The account's prompt preset and the presets to choose from, as every preset picker reads
// them: the composer's chip and the Prompt preset tab share these queries, so a choice or an
// archive made in one shows in the other at once.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { BUILTIN_PRESET_LABEL } from "@rp/shared/generation.ts"
import type { LibraryRef, RefId } from "@rp/shared/library.ts"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useState } from "react"
import { allOf, useAction } from "../../actions.tsx"
import { onLibraryChange } from "../../libraryChanges.ts"
import { AppClient } from "../../rpc.ts"
import type { ChatSession } from "../chat/session.ts"
import { defaultsAtom } from "./defaults.ts"

const presetsAtom = allOf({
  live: AppClient.query("ListLibrary", { kind: "preset" }, { reactivityKeys: ["library"] }),
  archived: AppClient.query("ListLibrary", { kind: "preset", archived: true }, { reactivityKeys: ["library"] })
})

/** The built-in preset's value in a picker: the account has none of its own chosen. */
export const BUILTIN = "builtin"

export interface PresetSelection {
  /** False until the account's choice and both lists are read. */
  readonly loaded: boolean
  /** `BUILTIN` or the chosen ref's id. */
  readonly value: string
  /** The chosen preset's entry; null for the built-in one, or one no list has. */
  readonly current: LibraryRef | null
  /** What the chip and the tab say: the preset's name, or "Default (built-in)". */
  readonly label: string | null
  readonly live: ReadonlyArray<LibraryRef>
  readonly archived: ReadonlyArray<LibraryRef>
  /** Exactly what choosing in the composer does: the account's preset, for every chat's next reply. */
  readonly choose: (value: string) => Promise<boolean>
  readonly setArchived: (ref: LibraryRef, archived: boolean) => Promise<LibraryRef | null>
  /** Reads the lists again (the times under the names move on with each reply). */
  readonly refresh: () => void
  readonly error: ReturnType<typeof useAction>["error"]
}

export function usePresetSelection(session: ChatSession | null): PresetSelection {
  const action = useAction()
  const presets = useAtomValue(presetsAtom)
  const defaults = useAtomValue(defaultsAtom)
  const refreshPresets = useAtomRefresh(presetsAtom)
  const refreshDefaults = useAtomRefresh(defaultsAtom)
  // Another tab or device can change either; the chat says when its next context changed.
  useEffect(() => onLibraryChange(refreshPresets), [refreshPresets])
  useEffect(
    () =>
      session?.subscribeContext(() => {
        refreshDefaults()
        refreshPresets()
      }),
    [session, refreshDefaults, refreshPresets]
  )
  const lists = AsyncResult.isSuccess(presets) ? presets.value : null
  const chosen = AsyncResult.isSuccess(defaults) ? defaults.value.preset : undefined
  const live = lists?.live ?? []
  const archived = lists?.archived ?? []
  const found =
    chosen == null ? null : (live.find((ref) => ref.id === chosen) ?? archived.find((ref) => ref.id === chosen) ?? null)
  // The two lists are read again one after the other, so archiving the preset in use leaves it,
  // for a moment, in neither: it's still the one last seen, and the chip doesn't flash "…".
  const [seen, setSeen] = useState<LibraryRef | null>(null)
  if (found !== null && found !== seen) setSeen(found)
  const current = found ?? (seen !== null && seen.id === chosen ? seen : null)
  const loaded = lists !== null && chosen !== undefined
  return {
    loaded,
    value: chosen ?? BUILTIN,
    current,
    label: !loaded ? null : chosen === null ? BUILTIN_PRESET_LABEL : (current?.label ?? null),
    live,
    archived,
    choose: (value) =>
      action
        .run(
          (client) =>
            client("ChangeGenerationDefaults", { change: { preset: value === BUILTIN ? null : (value as RefId) } }),
          ["settings"]
        )
        .then((result) => result.ok),
    setArchived: (ref, next) =>
      action
        .run((client) => client("SetRefArchived", { refId: ref.id, archived: next }), ["library"])
        .then((result) => (result.ok ? result.value : null)),
    refresh: refreshPresets,
    error: action.error
  }
}
