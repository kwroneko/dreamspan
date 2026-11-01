// The side panel's Prompt preset tab (DESIGN §6.2a; owner, 2026-11-01): the whole preset,
// editable in the column. The prompt order is the large editor's own document in its "column"
// layout, sharing the workspace's store, so an edit in either shows in the other. Nothing is
// committed as it's made: every change, a switch flip included, is a draft until the floating
// bar's Save (the same Save and Revert as the large editor's toolbar), or goes with Revert.
import type { RefId } from "@rp/shared/library.ts"
import { useEffect, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Disclosure } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { useCaller } from "../editor/caller.ts"
import { RecoveredNotice, RestoredNotice } from "../editor/controls.tsx"
import { describePresetChanges } from "../editor/presetChanges.ts"
import { PresetSettings } from "../editor/PresetEditor.tsx"
import { presetEditorWarnings } from "../editor/presetSections.ts"
import { usePresetWorkspace } from "../editor/PresetWorkspace.tsx"
import { PromptDocument } from "../editor/PromptDocument.tsx"
import { RefName } from "../editor/RefDialogs.tsx"
import { SaveRevert } from "../editor/SaveRevert.tsx"
import { type EditorStore, useEditorState, useLeaveGuard, useWorkingDoc } from "../editor/store.ts"
import type { ChatSession, ChatView } from "./session.ts"

/**
 * Says what's unsaved, with Revert and Save, stuck to the bottom of the panel while it scrolls;
 * gone once nothing is unsaved. Its own component, so typing re-renders only it.
 */
function UnsavedBar({ store }: { store: EditorStore }) {
  const workspace = usePresetWorkspace()
  const state = useEditorState(store)
  const working = useWorkingDoc(store)
  if (state.dirty === 0) return null
  const parts = describePresetChanges(store.head, working, store.dirtyFields())
  return (
    <div
      role="region"
      aria-label="Unsaved changes"
      className="sticky bottom-0 z-20 mt-auto flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-accent/40 bg-surface-raised p-2.5 shadow-lg"
    >
      <p role="status" className="min-w-0 flex-1 basis-40 text-sm [overflow-wrap:anywhere]">
        <span className="font-medium">Unsaved:</span>{" "}
        <span className="text-muted">{parts.length > 0 ? parts.join(" · ") : "changes"}</span>
      </p>
      <div className="ml-auto flex shrink-0 flex-wrap gap-2">
        <SaveRevert store={store} current={workspace?.chat} what={parts.join(", ")} />
      </div>
    </div>
  )
}

function PresetColumn({ store }: { store: EditorStore }) {
  const workspace = usePresetWorkspace()
  const call = useCaller()
  const state = useEditorState(store)
  const [goTo, setGoTo] = useState<{ readonly identifier: string } | null>(null)
  useEffect(() => {
    void store.load()
  }, [store])
  useLeaveGuard(store)
  if (state.loadError) return <ErrorAlert error={state.loadError} />
  if (!state.snapshot) return <p role="status">Loading preset…</p>
  return (
    <div className="flex min-h-full flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium">
            <RefName store={store} />
          </span>
          <p className="text-xs text-muted">Used by every chat with this preset. Changes wait for Save.</p>
        </div>
        <Tooltip label="The preset editor over the chat, with room to work and search">
          <Button
            className="h-8 shrink-0 px-2.5"
            aria-label="Open the preset in the large editor"
            onClick={() => workspace?.open(store.refId)}
          >
            <Icon name="expand" />
            Large editor
          </Button>
        </Tooltip>
      </div>
      {state.saveError && (
        <ErrorAlert error={{ ...state.saveError, message: `A change couldn't be kept: ${state.saveError.message}` }} />
      )}
      <RestoredNotice count={state.restored} />
      <RecoveredNotice store={store} />
      <SlotOutlet slot={presetEditorWarnings} props={{ store, onGoTo: (identifier) => setGoTo({ identifier }) }} />
      <PromptDocument
        store={store}
        context={workspace?.context}
        layout="column"
        goTo={goTo}
        onOpenLarge={(identifier) => workspace?.open(store.refId, identifier)}
      />
      <Disclosure lazy title="End of request, prefill, utility prompts, regex scripts">
        <PresetSettings store={store} call={call} />
      </Disclosure>
      <UnsavedBar store={store} />
    </div>
  )
}

/**
 * The account's selected preset, the next reply's when the chat has no context estimate yet: a
 * chat without messages has none, so the tab would otherwise wait for a first message.
 */
function useSelectedPreset(session: ChatSession) {
  const call = useCaller()
  const [selected, setSelected] = useState<{ readonly ref: RefId | null } | null>(null)
  useEffect(() => {
    let live = true
    const refresh = () =>
      void call((client) => client("GetGenerationDefaults", undefined)).then((result) => {
        if (live && result.ok) setSelected({ ref: result.value.preset })
      })
    const unsubscribe = session.subscribeContext(refresh)
    refresh()
    return () => {
      live = false
      unsubscribe()
    }
  }, [session, call])
  return selected
}

export function PresetTab({ session, view }: { session: ChatSession; view: ChatView }) {
  const workspace = usePresetWorkspace()
  const selected = useSelectedPreset(session)
  // The estimate names the preset the next reply is assembled with (a chat's own copy, say);
  // until there is one, the account's selection.
  const estimated = view.history?.preset
  const ref = estimated ? estimated.ref : selected?.ref
  const builtin = estimated ? estimated.scope === "builtin" : selected !== null && selected.ref === null
  return ref && workspace ? (
    <PresetColumn key={ref} store={workspace.store(ref as RefId)} />
  ) : (
    <p className="text-sm text-muted">
      {builtin ? "SillyTavern's built-in default. Import a preset to edit its prompts." : "Loading the current preset…"}
    </p>
  )
}
