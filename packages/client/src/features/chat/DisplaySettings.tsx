import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { AsyncResult, Atom } from "effect/reactivity"
import type { EditorSnapshot } from "@rp/shared/editorApi.ts"
import type { RefId } from "@rp/shared/library.ts"
import type { RegexScript } from "@rp/shared/docs/preset.ts"
import { createContext, useContext, useMemo, useEffect, useState, type ReactNode } from "react"
import { AppClient } from "../../rpc.ts"
import { RadioGroup, Switch } from "../../ui/Choice.tsx"
import { Fieldset } from "../../ui/Field.tsx"
import { useViewPrefs } from "../../ui/viewPrefs.ts"
import { useSession } from "../../session.ts"
import { onLibraryChange } from "../../libraryChanges.ts"
import type { ChatSurfaceProps } from "./presentation.tsx"
import type { ChatSession } from "./session.ts"

import { MessageColorSettings } from "./MessageColors.tsx"

const NO_SCRIPTS: ReadonlyArray<RegexScript> = []
const DisplayContext = createContext<{ scripts: ReadonlyArray<RegexScript>; leafDepth: number | null }>({
  scripts: [],
  leafDepth: null
})
export const useDisplayContext = () => useContext(DisplayContext)
const presetQuery = Atom.family((key: string): Atom.Atom<AsyncResult.AsyncResult<EditorSnapshot | null, unknown>> => {
  const [, refId] = JSON.parse(key) as [string, RefId | null]
  if (!refId) return Atom.make(AsyncResult.success(null))
  return AppClient.query("OpenEditor", { refId }, { reactivityKeys: ["library"] })
})
function PresetDisplay({
  session,
  refId,
  leafDepth,
  children
}: {
  session: ChatSession
  refId: string | null
  leafDepth: number | null
  children: ReactNode
}) {
  const userId = useSession().user.id
  const query = presetQuery(JSON.stringify([userId, refId]))
  const result = useAtomValue(query)
  const refresh = useAtomRefresh(query)
  useEffect(() => {
    if (!refId) return
    // Server context notifications include edits from other devices, even when the
    // preset's id and prompt context did not change. Focus also refreshes after a
    // suspended tab resumes; the library signal covers same-origin editor tabs.
    const stopContext = session.subscribeContext(refresh)
    const stopLibrary = onLibraryChange(refresh)
    return () => {
      stopContext()
      stopLibrary()
    }
  }, [session, refId, refresh])
  // Only committed document content, never unsaved drafts or a previous failed read.
  const doc = AsyncResult.isSuccess(result) ? result.value?.doc : null
  const scripts = doc?.regex_approved === true ? (doc.regex as ReadonlyArray<RegexScript>) : NO_SCRIPTS
  const value = useMemo(() => ({ scripts, leafDepth }), [scripts, leafDepth])
  return <DisplayContext value={value}>{children}</DisplayContext>
}
export function DisplayProvider({ session, view, children }: ChatSurfaceProps) {
  const viewer = useViewPrefs()
  const refId = viewer.prefs.displayRegex ? (view.history?.preset?.ref ?? null) : null
  const chatId = view.chat?.id
  const key = `${view.forkId}:${view.leafSlotId}`
  const loadedDepth = view.entries.find((entry) => entry.slotId === view.leafSlotId)?.depth
  const [tip, setTip] = useState<{ key: string; depth: number } | null>(null)
  useEffect(() => {
    if (!chatId || !refId || loadedDepth !== undefined || view.leafSlotId === null) return
    let active = true
    void session
      .call((client) =>
        client("ReadPath", {
          chatId,
          forkId: view.forkId,
          leafSlotId: view.leafSlotId,
          range: { _tag: "Bottom" },
          limit: 1
        })
      )
      .then((result) => {
        if (active && result.ok) setTip({ key, depth: result.value.entries.at(-1)?.depth ?? 0 })
      })
    return () => {
      active = false
    }
  }, [session, chatId, refId, loadedDepth, view.forkId, view.leafSlotId, key])
  const leafDepth = loadedDepth ?? (tip?.key === key ? tip.depth : view.leafSlotId === null ? 0 : null)
  return (
    <PresetDisplay session={session} refId={refId} leafDepth={leafDepth}>
      {children}
    </PresetDisplay>
  )
}
export function DisplaySettings() {
  const viewer = useViewPrefs()
  return (
    <div className="flex flex-col gap-6">
      <Fieldset
        legend="Enter sends"
        description="Your account preference for both chat and new-chat composers. Ctrl/Cmd+Enter always submits; Shift+Enter adds a line."
      >
        <RadioGroup
          value={viewer.prefs.enterSends}
          disabled={!viewer.ready}
          onValueChange={(enterSends) => void viewer.change({ enterSends })}
          options={[
            {
              value: "automatic",
              label: "Automatic",
              description: "Enter sends on a desktop keyboard and inserts a line on touch devices."
            },
            { value: "always", label: "Always", description: "Enter sends on every device." },
            { value: "never", label: "Never", description: "Enter inserts a line. Ctrl/Cmd+Enter sends." }
          ]}
        />
      </Fieldset>
      <MessageColorSettings />
      <Fieldset
        legend="Display transformations"
        description="These account choices change what you see in chats. Stored text, editing, copying, and future requests keep the original text. Streaming replies stay as written until they finish."
      >
        <Switch
          checked={viewer.prefs.outputMacros}
          disabled={!viewer.ready || viewer.pending}
          onCheckedChange={(outputMacros) => void viewer.change({ outputMacros })}
          description="Resolve macros such as {{user}} in finished model output. Human messages stay as written."
        >
          Expand macros in model output
        </Switch>
        <Switch
          checked={viewer.prefs.displayRegex}
          disabled={!viewer.ready || viewer.pending}
          onCheckedChange={(displayRegex) => void viewer.change({ displayRegex })}
          description="Use display-only scripts from the current prompt preset, after macros. The preset's scripts must also be approved in its editor. Rules can apply to human and model messages; prompt-only and storage rewrite scripts are excluded."
        >
          Use preset display regex
        </Switch>
        <p className="text-sm text-muted">
          Slow or oversized rules are skipped with an explanation beside the message. Turn these switches off to see the
          original text.
        </p>
        {viewer.error && (
          <p role="alert" className="text-sm text-danger">
            {viewer.error.message}
          </p>
        )}
      </Fieldset>
    </div>
  )
}
