// HTML in messages, for the chat view (spec/HTML-MESSAGES.md): the viewer's "Show HTML as
// formatting" for the message renderer, and the chat's card styles in one constructed
// stylesheet, kept from every message in the loaded window (ui/html/messageHtml.ts).
import { useEffect, useMemo, useState, type ReactNode } from "react"
import { Switch } from "../../ui/Choice.tsx"
import {
  HtmlChatContext,
  HtmlMessageContext,
  HtmlSettingsContext,
  MessageStyles,
  type HtmlChat
} from "../../ui/html/messageHtml.ts"
import { useViewPrefs } from "../../ui/viewPrefs.ts"
import type { ChatSurfaceProps } from "./presentation.tsx"

type Entries = ReadonlyArray<{ readonly key: string; readonly text: string }>
/** The viewer's setting and a stylesheet adopted while mounted, holding `entries`' styles. */
function useHtml(entries: Entries) {
  const html = useViewPrefs().prefs.htmlFormatting
  const settings = useMemo(() => ({ html }), [html])
  const [chat] = useState<HtmlChat>(() => ({ styles: new MessageStyles() }))
  useEffect(() => chat.styles.attach(), [chat])
  useEffect(() => chat.styles.setLoaded(html ? entries : []), [chat, html, entries])
  return { settings, chat }
}

export function HtmlProvider({ view, children }: ChatSurfaceProps) {
  const entries = useMemo(
    () => view.entries.map((entry) => ({ key: entry.slotId, text: entry.version.content })),
    [view.entries]
  )
  const { settings, chat } = useHtml(entries)
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
