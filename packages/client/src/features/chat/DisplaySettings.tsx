import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { positionOf } from "./position.ts"
import { AsyncResult, Atom } from "effect/reactivity"
import type { EntityId } from "@rp/shared/chat.ts"
import type { Cast } from "@rp/shared/chatSetupApi.ts"
import type { EditorSnapshot } from "@rp/shared/editorApi.ts"
import type { RefId } from "@rp/shared/library.ts"
import type { RegexScript } from "@rp/shared/docs/regexScript.ts"
import type { GlobalRegex } from "@rp/shared/regexScripts.ts"
import { createContext, useContext, useMemo, useEffect, useState, type ReactNode } from "react"
import { AppClient } from "../../rpc.ts"
import { RadioGroup, Switch } from "../../ui/Choice.tsx"
import { Fieldset } from "../../ui/Field.tsx"
import { useViewPrefs } from "../../ui/viewPrefs.ts"
import { useSession } from "../../session.ts"
import { onLibraryChange } from "../../libraryChanges.ts"
import { globalRegexAtom } from "../regex/data.ts"
import { useRefreshOnContext } from "../pickers/defaults.ts"
import { approvedScripts, CardScripts } from "./displayScripts.ts"
import type { ChatSurfaceProps } from "./presentation.tsx"
import type { ChatSession } from "./session.ts"

import { ChatWidthSetting } from "./ChatWidth.tsx"
import { MessageColorSettings } from "./MessageColors.tsx"
import { MessageDetailSettings } from "./messageDetails.tsx"

const NO_SCRIPTS: ReadonlyArray<RegexScript> = []

/**
 * What a message's display regex reads (displayScripts.ts): the global and approved preset
 * scripts, the approved card scripts by member, and the cast that names a user-side
 * message's character. Empty while the viewer's switch is off.
 */
export interface DisplayScriptSources {
  readonly global: ReadonlyArray<RegexScript>
  readonly preset: ReadonlyArray<RegexScript>
  readonly cards: CardScripts | null
  readonly cast: Pick<Cast, "participants" | "playedByMe"> | null
  readonly leafDepth: number | null
}
const DisplayContext = createContext<DisplayScriptSources>({
  global: NO_SCRIPTS,
  preset: NO_SCRIPTS,
  cards: null,
  cast: null,
  leafDepth: null
})
export const useDisplayContext = () => useContext(DisplayContext)
const presetQuery = Atom.family((key: string): Atom.Atom<AsyncResult.AsyncResult<EditorSnapshot | null, unknown>> => {
  const [, refId] = JSON.parse(key) as [string, RefId | null]
  if (!refId) return Atom.make(AsyncResult.success(null))
  return AppClient.query("OpenEditor", { refId }, { reactivityKeys: ["library"] })
})
const globalQuery = Atom.family((key: string): Atom.Atom<AsyncResult.AsyncResult<GlobalRegex | null, unknown>> => {
  const [, on] = JSON.parse(key) as [string, boolean]
  return on ? globalRegexAtom : Atom.make(AsyncResult.success(null))
})
function ScriptDisplay({
  session,
  refId,
  on,
  cast,
  leafDepth,
  children
}: {
  session: ChatSession
  refId: string | null
  on: boolean
  cast: Cast | null
  leafDepth: number | null
  children: ReactNode
}) {
  const userId = useSession().user.id
  const query = presetQuery(JSON.stringify([userId, refId]))
  const result = useAtomValue(query)
  const refresh = useAtomRefresh(query)
  const global = globalQuery(JSON.stringify([userId, on]))
  const globalResult = useAtomValue(global)
  const refreshGlobal = useAtomRefresh(global)
  useRefreshOnContext(on ? session : null, global)
  const cards = useMemo(
    () =>
      on
        ? new CardScripts((entityId: EntityId) =>
            session
              .call((client) => client("GetCardForChat", { entityId }))
              .then((read) => (read.ok ? (read.value.regex ?? null) : null))
          )
        : null,
    [session, on]
  )
  useEffect(() => {
    if (!on) return
    // Server context notifications include edits from other devices, even when the
    // preset's id and prompt context did not change. Focus also refreshes after a
    // suspended tab resumes; the library signal covers same-origin editor and settings tabs.
    const all = () => {
      if (refId) refresh()
      refreshGlobal()
      cards?.refresh()
    }
    const stopContext = session.subscribeContext((initialSnapshot) => {
      if (initialSnapshot) return
      if (refId) refresh()
      cards?.refresh()
    })
    const stopLibrary = onLibraryChange(all)
    return () => {
      stopContext()
      stopLibrary()
    }
  }, [session, on, refId, refresh, refreshGlobal, cards])
  // Only committed document content, never unsaved drafts or a previous failed read.
  const preset = approvedScripts(AsyncResult.isSuccess(result) ? result.value?.doc : null)
  const globalScripts =
    AsyncResult.isSuccess(globalResult) && globalResult.value ? globalResult.value.scripts : NO_SCRIPTS
  const value = useMemo(
    () => ({ global: globalScripts, preset, cards, cast: on ? cast : null, leafDepth }),
    [globalScripts, preset, cards, on, cast, leafDepth]
  )
  return <DisplayContext value={value}>{children}</DisplayContext>
}
export function DisplayProvider({ session, view, children }: ChatSurfaceProps) {
  const viewer = useViewPrefs()
  const on = viewer.prefs.displayRegex && view.history !== null
  const refId = on ? (view.history?.preset?.ref ?? null) : null
  const chatId = view.chat?.id
  const key = `${view.forkId}:${view.leafSlotId}`
  const loadedEntry = view.entries.find((entry) => entry.slotId === view.leafSlotId)
  const loadedDepth = loadedEntry && positionOf(loadedEntry)
  const [tip, setTip] = useState<{ key: string; depth: number } | null>(null)
  useEffect(() => {
    if (!chatId || !on || loadedDepth !== undefined || view.leafSlotId === null) return
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
        if (active && result.ok)
          setTip({ key, depth: result.value.entries.at(-1) ? positionOf(result.value.entries.at(-1)!) : 0 })
      })
    return () => {
      active = false
    }
  }, [session, chatId, on, loadedDepth, view.forkId, view.leafSlotId, key])
  const leafDepth = loadedDepth ?? (tip?.key === key ? tip.depth : view.leafSlotId === null ? 0 : null)
  return (
    <ScriptDisplay session={session} refId={refId} on={on} cast={view.cast} leafDepth={leafDepth}>
      {children}
    </ScriptDisplay>
  )
}
export function DisplaySettings() {
  const viewer = useViewPrefs()
  return (
    <div className="flex flex-col gap-6">
      <ChatWidthSetting />
      <Fieldset legend="Enter sends" about="Ctrl/Cmd+Enter always sends; Shift+Enter adds a line.">
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
      <MessageDetailSettings />
      <Fieldset
        legend="Display transformations"
        about="Change only what you see: the text you edit, copy and send stays as written."
      >
        <Switch
          checked={viewer.prefs.outputMacros}
          disabled={!viewer.ready || viewer.pending}
          onCheckedChange={(outputMacros) => void viewer.change({ outputMacros })}
          about="Show names and other values in place of macros such as {{user}} in completed replies. Your messages stay as written."
        >
          Expand macros in model output
        </Switch>
        <Switch
          checked={viewer.prefs.displayRegex}
          disabled={!viewer.ready || viewer.pending}
          onCheckedChange={(displayRegex) => void viewer.change({ displayRegex })}
          about="Apply regex scripts to how messages look. Preset and card scripts need your approval first. Scripts that change prompts or saved messages have their own controls."
        >
          Use display regex scripts
        </Switch>
        {viewer.error && (
          <p role="alert" className="text-sm text-danger">
            {viewer.error.message}
          </p>
        )}
      </Fieldset>
    </div>
  )
}
