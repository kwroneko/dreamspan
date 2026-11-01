// The side panel's Prompt preset tab (DESIGN §6.2a; owner, 2026-11-01): the whole preset,
// editable in the column. The prompt order is the large editor's own document in its "column"
// layout, sharing the workspace's store, so an edit in either shows in the other. What's typed
// and switched is used by the next reply as it's made (live text, owner 2026-11-01), and Save
// with its message cuts a revision; moving or deleting a prompt is held behind the floating
// bar's Save and Revert (heldOrder.ts), being easy to do by accident.
import { useEffect, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Disclosure } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { useCaller } from "../editor/caller.ts"
import { RecoveredNotice, RestoredNotice } from "../editor/controls.tsx"
import { PresetSettings } from "../editor/PresetEditor.tsx"
import { presetEditorWarnings } from "../editor/presetSections.ts"
import { usePresetWorkspace } from "../editor/PresetWorkspace.tsx"
import { PromptDocument } from "../editor/PromptDocument.tsx"
import { RefName } from "../editor/RefDialogs.tsx"
import { HeldChangesBar } from "../editor/SaveRevert.tsx"
import { SaveRevision } from "../editor/SaveRevision.tsx"
import { type EditorStore, useEditorState, useLeaveGuard } from "../editor/store.ts"
import { useChatPreset } from "./chatPreset.ts"
import type { ChatSession, ChatView } from "./session.ts"

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
          <p className="text-xs text-muted">
            Used by every chat with this preset, as you type. Moving or deleting a prompt waits for Save.
          </p>
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
      <SaveRevision store={store} />
      <RestoredNotice count={state.restored} />
      <RecoveredNotice store={store} />
      <SlotOutlet slot={presetEditorWarnings} props={{ store, onGoTo: (identifier) => setGoTo({ identifier }) }} />
      <PromptDocument
        store={store}
        context={workspace?.context}
        layout="column"
        goTo={goTo}
        onOpenLarge={(identifier) => workspace?.open(store.refId, identifier)}
        onOpenLorebook={workspace ? (ref) => workspace.open(ref) : undefined}
      />
      <Disclosure lazy title="End of request, prefill, utility prompts, regex scripts">
        <PresetSettings store={store} call={call} />
      </Disclosure>
      <HeldChangesBar store={store} floating />
    </div>
  )
}

export function PresetTab({ session, view }: { session: ChatSession; view: ChatView }) {
  const workspace = usePresetWorkspace()
  const { ref, builtin } = useChatPreset(session, view)
  return ref && workspace ? (
    <PresetColumn key={ref} store={workspace.store(ref)} />
  ) : (
    <p className="text-sm text-muted">
      {builtin ? "SillyTavern's built-in default. Import a preset to edit its prompts." : "Loading the current preset…"}
    </p>
  )
}
