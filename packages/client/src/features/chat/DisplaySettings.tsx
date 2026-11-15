import { ExternalMediaDefault } from "./externalMedia.tsx"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { positionOf } from "./position.ts"
import { AsyncResult, Atom } from "effect/reactivity"
import type { EntityId } from "@rp/shared/chat.ts"
import type { Cast } from "@rp/shared/chatSetupApi.ts"
import type { EditorSnapshot } from "@rp/shared/editorApi.ts"
import type { RefId } from "@rp/shared/library.ts"
import type { RegexScript } from "@rp/shared/docs/regexScript.ts"
import type { GlobalRegex } from "@rp/shared/regexScripts.ts"
import { createContext, useContext, useMemo, useEffect, useState, useSyncExternalStore, type ReactNode } from "react"
import { AppClient } from "../../rpc.ts"
import { RadioGroup, Switch } from "../../ui/Choice.tsx"
import { Field, Fieldset } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { useViewPrefs } from "../../ui/viewPrefs.ts"
import { useSession } from "../../session.ts"
import { onLibraryChange } from "../../libraryChanges.ts"
import { globalRegexAtom } from "../regex/data.ts"
import { useRefreshOnContext } from "../pickers/defaults.ts"
import { useCaller } from "../editor/caller.ts"
import { displayTransforms } from "./displayPipeline.ts"
import { timelineTransforms } from "./timelineContributions.tsx"
import { displayScriptLists } from "./displayScripts.ts"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { builtinReplacement } from "@rp/shared/builtinParts.ts"
import { approvedScripts, CardScripts } from "./displayScripts.ts"
import type { ChatSurfaceProps } from "./presentation.tsx"
import type { ChatSession } from "./session.ts"

import { ChatDensitySetting } from "./ChatDensity.tsx"
import { ChatWidthSetting } from "./ChatWidth.tsx"
import { HtmlFormattingSwitch, PanelDepthSelect } from "./htmlDisplay.tsx"
import { MessageColorSettings } from "./MessageColors.tsx"
import { MessageDetailSettings } from "./messageDetails.tsx"
import { StateMarkerSettings } from "./StateRows.tsx"

const NO_SCRIPTS: ReadonlyArray<RegexScript> = []

/** A preset's panel permissions (spec/HTML-MESSAGES.md §3.4), by its library entry. */
interface PresetPanels {
  readonly refId: RefId
  readonly name: string
  readonly scripts: boolean
  readonly network: boolean
}

/**
 * What a message's panels need to know whether their scripts run (panelPermits.ts): the
 * members' cards, the cast that names a user-side message's character, the preset's
 * permissions, and how to allow a source. Null while "Show HTML as formatting" is off.
 */
interface PanelSources {
  readonly cards: CardScripts
  readonly cast: Pick<Cast, "participants" | "playedByMe"> | null
  readonly preset: PresetPanels | null
  /** Lets a card's or the preset's panels run scripts; false when that failed. */
  readonly allow: (refId: RefId) => Promise<boolean>
}

/**
 * What a message's display regex reads (displayScripts.ts): the global and approved preset
 * scripts, the approved card scripts by member, and the cast that names a user-side
 * message's character. Empty while the viewer's switch is off. `panels` is for its panels.
 */
export interface DisplayScriptSources {
  readonly global: ReadonlyArray<RegexScript>
  readonly preset: ReadonlyArray<RegexScript>
  readonly cards: CardScripts | null
  readonly cast: Pick<Cast, "participants" | "playedByMe"> | null
  readonly leafDepth: number | null
  readonly panels: PanelSources | null
}
const DisplayContext = createContext<DisplayScriptSources>({
  global: NO_SCRIPTS,
  preset: NO_SCRIPTS,
  cards: null,
  cast: null,
  leafDepth: null,
  panels: null
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
  panels,
  cast,
  leafDepth,
  children
}: {
  session: ChatSession
  refId: string | null
  on: boolean
  /** Messages show HTML, so their panels' permissions are read too. */
  panels: boolean
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
  const reads = on || panels
  const store = useMemo(
    () =>
      reads
        ? new CardScripts((entityId: EntityId) =>
            session
              .call((client) => client("GetCardForChat", { entityId }))
              .then((read) =>
                read.ok
                  ? {
                      scripts: read.value.regex ?? NO_SCRIPTS,
                      panels:
                        read.value.refId === undefined
                          ? null
                          : {
                              refId: read.value.refId,
                              name: read.value.card.name,
                              scripts: read.value.htmlScripts === true,
                              network: read.value.htmlNetwork === true
                            }
                    }
                  : null
              )
          )
        : null,
    [session, reads]
  )
  useEffect(() => {
    if (!reads) return
    // Server context notifications include edits from other devices, even when the
    // preset's id and prompt context did not change. Focus also refreshes after a
    // suspended tab resumes; the library signal covers same-origin editor and settings tabs.
    const all = () => {
      if (refId) refresh()
      refreshGlobal()
      store?.refresh()
    }
    const stopContext = session.subscribeContext((initialSnapshot) => {
      if (initialSnapshot) return
      if (refId) refresh()
      store?.refresh()
    })
    const stopLibrary = onLibraryChange(all)
    return () => {
      stopContext()
      stopLibrary()
    }
  }, [session, reads, refId, refresh, refreshGlobal, store])
  // Only committed document content, never unsaved drafts or a previous failed read.
  const snapshot = AsyncResult.isSuccess(result) ? result.value : null
  const preset = on ? approvedScripts(snapshot?.doc) : NO_SCRIPTS
  const globalScripts =
    on && AsyncResult.isSuccess(globalResult) && globalResult.value ? globalResult.value.scripts : NO_SCRIPTS
  const call = useCaller()
  const presetScripts = snapshot?.doc.html_scripts_approved === true
  const presetNetwork = presetScripts && snapshot?.doc.html_network_approved === true
  const presetRef = snapshot?.ref.id ?? null
  const presetName = snapshot?.ref.label ?? ""
  const panelSources = useMemo((): PanelSources | null => {
    if (!panels || store === null) return null
    return {
      cards: store,
      cast,
      preset:
        presetRef === null
          ? null
          : { refId: presetRef, name: presetName, scripts: presetScripts, network: presetNetwork },
      allow: async (target) => {
        // Allowing scripts keeps the internet off: that's the editor's, once scripts run.
        const done = await call(
          (client) => client("SetHtmlApproval", { refId: target, scripts: true, network: false }),
          ["library"]
        )
        store.refresh()
        return done.ok
      }
    }
  }, [panels, store, cast, presetRef, presetName, presetScripts, presetNetwork, call])
  const value = useMemo(
    () => ({
      global: globalScripts,
      preset,
      cards: on ? store : null,
      cast: on ? cast : null,
      leafDepth,
      panels: panelSources
    }),
    [globalScripts, preset, store, on, cast, leafDepth, panelSources]
  )
  return <DisplayContext value={value}>{children}</DisplayContext>
}
export function DisplayProvider({ session, view, children }: ChatSurfaceProps) {
  const viewer = useViewPrefs()
  const on = viewer.prefs.displayRegex && view.history !== null
  const panels = viewer.prefs.htmlFormatting && view.history !== null
  const refId = on || panels ? (view.history?.preset?.ref ?? null) : null
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
    <ScriptDisplay session={session} refId={refId} on={on} panels={panels} cast={view.cast} leafDepth={leafDepth}>
      {children}
    </ScriptDisplay>
  )
}
export function DisplaySettings() {
  const viewer = useViewPrefs()
  return (
    <div className="flex flex-col gap-6">
      <ChatWidthSetting />
      <ChatDensitySetting />
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
      <Field
        label="Message portrait size"
        about="Sets message portrait size on all your devices."
        error={viewer.error?.message}
      >
        <Select<typeof viewer.prefs.portraitSize>
          value={viewer.prefs.portraitSize}
          onValueChange={(portraitSize) => void viewer.change({ portraitSize })}
          items={[
            { value: "small", label: "Smallest (48 × 72)" },
            { value: "default", label: "Small (60 × 90)" },
            { value: "large", label: "Medium (72 × 108)" },
            { value: "largest", label: "Large (84 × 126)" }
          ]}
        />
      </Field>
      <MessageColorSettings />
      <MessageDetailSettings />
      <StateMarkerSettings />
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
        <ReplacedDisplayRules />
        <HtmlFormattingSwitch />
        <ExternalMediaDefault />
        <PanelDepthSelect />
        {viewer.error && (
          <p role="alert" className="text-sm text-danger">
            {viewer.error.message}
          </p>
        )}
      </Fieldset>
    </div>
  )
}

function ReplacedDisplayRules() {
  const transforms = useSyncExternalStore(displayTransforms.subscribe, displayTransforms.snapshot)
  const lists = useSyncExternalStore(displayScriptLists.subscribe, displayScriptLists.snapshot)
  const timeline = useSyncExternalStore(timelineTransforms.subscribe, timelineTransforms.snapshot)
  // The names consent and the copy picker use for the same parts (@rp/shared/builtinParts.ts).
  const replaced = (
    [
      ["displayTransforms", transforms.entries],
      ["displayScriptLists", lists.entries],
      ["timelineTransforms", timeline.entries]
    ] as const
  ).flatMap(([registry, entries]) =>
    entries
      .filter((rule) => rule.replacement)
      .map((rule) => ({
        key: `${registry}:${rule.id}`,
        name: builtinReplacement(`${registry}:${rule.id}`)?.label ?? rule.id,
        by: rule.replacement
      }))
  )
  if (!replaced.length) return null
  return (
    <ul aria-label="Replaced display rules" className="flex min-w-0 flex-col gap-1 text-sm text-muted">
      {replaced.map((rule) => (
        <li key={rule.key} className="[overflow-wrap:anywhere]">
          <Tooltip label="This browser copy changes only how the chat looks. Turn it off in Plugins to restore the original.">
            <span tabIndex={0}>
              {rule.name} · Replaced by {rule.by}
            </span>
          </Tooltip>
        </li>
      ))}
    </ul>
  )
}
