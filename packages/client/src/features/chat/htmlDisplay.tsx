// HTML in messages, for the chat view (spec/HTML-MESSAGES.md): the viewer's "Show HTML as
// formatting" for the message renderer, and the chat's card styles in one constructed
// stylesheet, kept from every message in the loaded window (ui/html/messageHtml.ts).
import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react"
import { Switch } from "../../ui/Choice.tsx"
import {
  HtmlChatContext,
  HtmlMessageContext,
  HtmlSettingsContext,
  MessageStyles,
  type HtmlChat
} from "../../ui/html/messageHtml.ts"
import { useExternalMediaRevision } from "./externalMedia.tsx"
import { FrameSlots } from "../../ui/html/frames.ts"
import { Field } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { useViewPrefs } from "../../ui/viewPrefs.ts"
import type { ChatSurfaceProps } from "./presentation.tsx"
import type { PanelDataSource } from "../../ui/html/parts.ts"
import type { ChatSession } from "./session.ts"

type Entries = ReadonlyArray<{ readonly key: string; readonly text: string }>
/** The viewer's setting and a stylesheet adopted while mounted, holding `entries`' styles. */
function useHtml(entries: Entries, mediaRevision = "", panelData?: PanelDataSource) {
  const { htmlFormatting: html, panelDepth } = useViewPrefs().prefs
  const settings = useMemo(() => ({ html, panelDepth }), [html, panelDepth])
  const [styles] = useState(() => new MessageStyles())
  const [frames] = useState(() => new FrameSlots())
  const chat = useMemo<HtmlChat>(
    () => ({ styles, frames, ...(panelData ? { panelData } : {}) }),
    [styles, frames, panelData]
  )
  useLayoutEffect(() => styles.clearReports(), [styles, mediaRevision])
  useEffect(() => styles.attach(), [styles])
  useEffect(() => styles.setLoaded(html ? entries : []), [styles, html, entries])
  return { settings, chat }
}

/**
 * What this chat view's panels may read (Tier B, `GetPanelData`): on the fork shown, so a
 * panel reads the versions and state it's shown with. Changes to the chat's messages or state
 * tell the live panels to read again.
 */
function panelSource(session: ChatSession): PanelDataSource {
  return {
    read: async (slotId) => {
      const { forkId } = session.snapshot()
      const result = await session.call((client) => client("GetPanelData", { chatId: session.chatId, forkId, slotId }))
      return result.ok ? result.value : null
    },
    subscribe: (listener) => {
      let revision = session.snapshot().pathRevision
      let fork = session.snapshot().forkId
      const stopView = session.subscribe(() => {
        const view = session.snapshot()
        if (view.pathRevision === revision && view.forkId === fork) return
        revision = view.pathRevision
        fork = view.forkId
        listener()
      })
      const stopState = session.subscribePositions(listener)
      return () => {
        stopView()
        stopState()
      }
    }
  }
}

export function HtmlProvider({ session, view, children }: ChatSurfaceProps) {
  const entries = useMemo(
    () => view.entries.map((entry) => ({ key: entry.slotId, text: entry.version.content })),
    [view.entries]
  )
  const revision = useExternalMediaRevision()
  const panelData = useMemo(() => panelSource(session), [session])
  const { settings, chat } = useHtml(entries, revision, panelData)
  return (
    <HtmlSettingsContext value={settings}>
      <HtmlChatContext value={chat}>{children}</HtmlChatContext>
    </HtmlSettingsContext>
  )
}

/** One message shown outside a chat view (a new chat's greeting), with its styles. */
export function HtmlPreview({ id, text, children }: { id: string; text: string; children: ReactNode }) {
  const entries = useMemo(() => [{ key: id, text }], [id, text])
  const { settings, chat } = useHtml(entries)
  const message = useMemo(() => ({ key: id }), [id])
  return (
    <HtmlSettingsContext value={settings}>
      <HtmlChatContext value={chat}>
        <HtmlMessageContext value={message}>{children}</HtmlMessageContext>
      </HtmlChatContext>
    </HtmlSettingsContext>
  )
}

/** The Interface panel's switch, beside the display regex one. */
export function HtmlFormattingSwitch() {
  const viewer = useViewPrefs()
  return (
    <Switch
      checked={viewer.prefs.htmlFormatting}
      disabled={!viewer.ready || viewer.pending}
      onCheckedChange={(htmlFormatting) => void viewer.change({ htmlFormatting })}
      about="Show markup in messages, like a card's boxes and tables, the way it's meant to look. Off shows it as text."
    >
      Show HTML as formatting
    </Switch>
  )
}

const DEPTHS = [1, 2, 3, 5, 10]
/** The Interface panel's panel depth, after the switch. */
export function PanelDepthSelect() {
  const viewer = useViewPrefs()
  const depth = viewer.prefs.panelDepth
  const depths = depth === null || DEPTHS.includes(depth) ? DEPTHS : [...DEPTHS, depth].sort((a, b) => a - b)
  return (
    <Field
      label="Run panels in"
      about="Panels are boxes a card draws in its own frame. Panels in older messages wait for you to run them."
    >
      <Select<string>
        value={depth === null ? "all" : String(depth)}
        disabled={!viewer.ready || viewer.pending}
        onValueChange={(value) => void viewer.change({ panelDepth: value === "all" ? null : Number(value) })}
        items={[
          { value: "all", label: "All messages" },
          ...depths.map((n) => ({ value: String(n), label: n === 1 ? "The last message" : `The last ${n} messages` }))
        ]}
      />
    </Field>
  )
}
