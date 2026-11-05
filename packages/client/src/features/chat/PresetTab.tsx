import { panelEditorActions } from "../editor/panelActions.tsx"
import { editorNotices } from "../editor/editorSlots.ts"
// The side panel's Prompt preset tab (DESIGN §6.2a; owner, 2026-11-01): the whole preset,
// editable in the column. The prompt order is the large editor's own document in its "column"
// layout, sharing the workspace's store, so an edit in either shows in the other. What's typed
// and switched is used by the next reply as it's made (live text, owner 2026-11-01), and Save
// with its message cuts a revision; moving, deleting or adding a prompt and attaching or taking
// off a lorebook wait behind the floating bar's Save and Revert (@rp/shared/presetHeld.ts;
// owner 2026-11-02), a prompt's on/off switch excepted.
import { endOfRequestText } from "@rp/shared/endOfRequest.ts"
import { useEffect, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { Badge, Disclosure } from "../../ui/Surface.tsx"
import { IconLink } from "../../ui/Tooltip.tsx"
import { useCaller } from "../editor/caller.ts"
import { RecoveredNotice, RestoredNotice } from "../editor/controls.tsx"
import { PresetSettings } from "../editor/PresetEditor.tsx"
import { presetEditorWarnings } from "../editor/presetSections.ts"
import { usePresetWorkspace } from "../editor/PresetWorkspace.tsx"
import { SearchNavigation, type SearchMatch } from "../editor/searchNavigation.ts"
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
  const [searchMatch, setSearchMatch] = useState<SearchMatch | null>(null)
  const [goTo, setGoTo] = useState<{ readonly identifier: string } | null>(null)
  useEffect(() => {
    void store.load()
  }, [store])
  useLeaveGuard(store)
  const matchPrompt = searchMatch?.path[1]
  const settingsMatch =
    searchMatch !== null &&
    (searchMatch.path[0] !== "prompts" ||
      (typeof matchPrompt === "string" && Boolean(endOfRequestText(matchPrompt.replace(/^identifier=/, "")))))
  if (state.loadError) return <ErrorAlert error={state.loadError} />
  if (!state.snapshot) return <p role="status">Loading preset…</p>
  return (
    <SearchNavigation value={searchMatch}>
      <div className="flex min-h-full flex-col gap-3">
        <div data-editor-header className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="min-w-0 font-medium">
              <RefName store={store}>
                <span className="block min-w-0 truncate">{state.snapshot.ref.label}</span>
              </RefName>
            </span>
            <Badge>preset</Badge>
          </div>
          <SaveRevision store={store} />
          {workspace && (
            <IconLink
              label="Open the preset in the large editor"
              hint="Opens this preset in the large editor"
              icon="expand"
              href={workspace.href(store.refId)}
              onOpen={() => workspace.open(store.refId)}
            />
          )}
        </div>
        {state.saveError && (
          <ErrorAlert
            error={{ ...state.saveError, message: `A change couldn't be kept: ${state.saveError.message}` }}
          />
        )}
        <RestoredNotice count={state.restored} />
        <RecoveredNotice store={store} />
        <SlotOutlet slot={editorNotices} props={{ store }} />
        <SlotOutlet slot={presetEditorWarnings} props={{ store, onGoTo: (identifier) => setGoTo({ identifier }) }} />
        <PromptDocument
          store={store}
          context={workspace?.context}
          layout="column"
          toolbarEnd={<SlotOutlet slot={panelEditorActions} props={{ store }} />}
          onSearchReveal={setSearchMatch}
          goTo={goTo}
          onOpenLarge={(identifier) => workspace?.open(store.refId, identifier)}
          onOpenLorebook={workspace ? (ref) => workspace.open(ref) : undefined}
        />
        <Disclosure lazy defaultOpen={settingsMatch} title="End of request, prefill, utility prompts, regex scripts">
          <PresetSettings store={store} call={call} />
        </Disclosure>
        <HeldChangesBar store={store} floating />
      </div>
    </SearchNavigation>
  )
}

export function PresetTab({ session, view }: { session: ChatSession; view: ChatView }) {
  const workspace = usePresetWorkspace()
  const { ref, builtin } = useChatPreset(session, view)
  return ref && workspace ? (
    <PresetColumn key={ref} store={workspace.store(ref)} />
  ) : (
    <p className="text-sm text-muted">
      {builtin ? "The built-in default. Import a preset to edit its prompts." : "Loading the current preset…"}
    </p>
  )
}
