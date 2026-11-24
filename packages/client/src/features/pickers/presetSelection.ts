import { libraryListAtom } from "../library/queries.ts"
// The account's prompt preset and the presets to choose from, as every preset picker reads
// them: the composer's chip and the Prompt preset tab share these queries, so a choice or an
// archive made in one shows in the other at once.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { BUILTIN_PRESET_LABEL } from "@dreamspan/shared/generation.ts"
import type { LibraryRef, RefId } from "@dreamspan/shared/library.ts"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useState, useSyncExternalStore } from "react"
import { allOf, useAction } from "../../actions.tsx"
import { onLibraryChange } from "../../libraryChanges.ts"
import type { ChatSession } from "../chat/session.ts"
import { defaultsAtom, useRefreshOnContext } from "./defaults.ts"

const livePresets = libraryListAtom("preset")
const archivedPresets = libraryListAtom("preset", true)
const presetsAtom = allOf({ live: livePresets, archived: archivedPresets })

/** The built-in preset's value in a picker: the account has none of its own chosen. */
export const BUILTIN = "builtin"

export interface PresetSelection {
  /**
   * Summary pickers choose only library refs and describe their own use; an editor's header
   * ("edit") switches which preset it edits, choosing none for a reply.
   */
  readonly usage?: "summary" | "edit" | undefined
  /** False until the account's choice and both lists are read. */
  readonly lock?: { readonly locked: boolean; readonly disabled: boolean; readonly change: (locked: boolean) => void }
  readonly loaded: boolean
  /** `BUILTIN` or the chosen ref's id. */
  readonly value: string
  /** The chosen preset's entry; null for the built-in one, or one no list has. */
  readonly current: LibraryRef | null
  /** What the chip and the tab say, or null while the selection loads. */
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
  // Another tab or device can change either; the chat says when its next context changed.
  useEffect(() => onLibraryChange(refreshPresets), [refreshPresets])
  useRefreshOnContext(session, defaultsAtom)
  useRefreshOnContext(session, livePresets)
  useRefreshOnContext(session, archivedPresets)
  const lists = AsyncResult.isSuccess(presets) ? presets.value : null
  const view = useSyncExternalStore(session?.subscribe ?? (() => () => {}), session?.snapshot ?? (() => null))
  const locked = view?.cast?.presetLocked ?? false
  const chosen = locked ? view!.cast!.preset : AsyncResult.isSuccess(defaults) ? defaults.value.preset : undefined
  const live = lists?.live ?? []
  const archived = lists?.archived ?? []
  const found =
    chosen == null ? null : (live.find((ref) => ref.id === chosen) ?? archived.find((ref) => ref.id === chosen) ?? null)
  // The two lists are read again one after the other, so archiving the preset in use leaves it,
  // for a moment, in neither: it's still the one last seen, and the chip doesn't flash "…".
  const [seen, setSeen] = useState<LibraryRef | null>(null)
  if (found !== null && found !== seen) setSeen(found)
  const current = found ?? (presets.waiting && seen?.id === chosen ? seen : null)
  const loaded = lists !== null && chosen !== undefined && (!session || view?.cast != null)
  return {
    ...(session
      ? {
          lock: {
            locked,
            disabled: chosen === undefined,
            change: (on: boolean) => {
              if (on && chosen !== undefined) void session.changeCast({ _tag: "Preset", ref: chosen })
              else if (!on) void session.changeCast({ _tag: "DefaultPreset" })
            }
          }
        }
      : {}),
    loaded,
    value: chosen ?? BUILTIN,
    current,
    label: !loaded ? null : chosen === null ? BUILTIN_PRESET_LABEL : (current?.label ?? "Preset unavailable"),
    live,
    archived,
    choose: async (value) => {
      const preset = value === BUILTIN ? null : (value as RefId)
      if (locked && session) return (await session.changeCast({ _tag: "Preset", ref: preset })).ok
      return (await action.run((client) => client("ChangeGenerationDefaults", { change: { preset } }), ["settings"])).ok
    },
    setArchived: (ref, next) =>
      action
        .run((client) => client("SetRefArchived", { refId: ref.id, archived: next }), ["library"])
        .then((result) => (result.ok ? result.value : null)),
    refresh: refreshPresets,
    error: action.error
  }
}

/**
 * The preset an editor edits, as its header's picker (the side panel's, switching documents):
 * the same lists, archive and New preset; choosing opens the other preset in this editor.
 */
export function useEditedPresetSelection(refId: RefId, label: string, open: (refId: RefId) => void): PresetSelection {
  const action = useAction()
  const presets = useAtomValue(presetsAtom)
  const refreshPresets = useAtomRefresh(presetsAtom)
  useEffect(() => onLibraryChange(refreshPresets), [refreshPresets])
  const lists = AsyncResult.isSuccess(presets) ? presets.value : null
  const live = lists?.live ?? []
  const archived = lists?.archived ?? []
  const current = live.find((ref) => ref.id === refId) ?? archived.find((ref) => ref.id === refId) ?? null
  return {
    usage: "edit",
    loaded: lists !== null,
    value: refId,
    current,
    label: current?.label ?? label,
    live,
    archived,
    choose: (value) => {
      if (value !== refId && value !== BUILTIN) open(value as RefId)
      return Promise.resolve(true)
    },
    setArchived: (ref, next) =>
      action
        .run((client) => client("SetRefArchived", { refId: ref.id, archived: next }), ["library"])
        .then((result) => (result.ok ? result.value : null)),
    refresh: refreshPresets,
    error: action.error
  }
}
