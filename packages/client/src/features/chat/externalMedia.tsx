// Account consent plus overrides. These controls are registered in the existing Interface
// and chat settings surfaces; the message note offers the two scoped Allow actions.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { DEFAULT_EXTERNAL_MEDIA, externalMediaAllowed, type ExternalMediaTarget } from "@rp/shared/externalMedia.ts"
import type { EntityId } from "@rp/shared/chat.ts"
import { AsyncResult, Atom } from "effect/reactivity"
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react"
import { useAction, ErrorAlert } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { useSession } from "../../session.ts"
import { Field } from "../../ui/Field.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { Select } from "../../ui/Select.tsx"
import type { MediaPermit } from "../../ui/html/media.ts"
import { useDisplayContext } from "./DisplaySettings.tsx"
import { messageCharacter } from "./displayScripts.ts"
import type { ChatSession } from "./session.ts"
import type { ChatSurfaceProps } from "./presentation.tsx"

const channel =
  typeof window === "undefined" || typeof BroadcastChannel === "undefined"
    ? null
    : new BroadcastChannel("rp.externalMedia")
const prefsFor = Atom.family((_userId: string) =>
  AppClient.query("GetExternalMediaPrefs", {}, { reactivityKeys: ["externalMedia"] })
)
function useExternalMedia() {
  const id = useSession().user.id
  const result = useAtomValue(prefsFor(id))
  const refresh = useAtomRefresh(prefsFor(id))
  const action = useAction()
  useEffect(() => {
    channel?.addEventListener("message", refresh)
    window.addEventListener("focus", refresh)
    return () => {
      channel?.removeEventListener("message", refresh)
      window.removeEventListener("focus", refresh)
    }
  }, [refresh])
  return {
    prefs: AsyncResult.isSuccess(result) ? result.value : DEFAULT_EXTERNAL_MEDIA,
    ready: AsyncResult.isSuccess(result),
    ...action,
    change: async (target: ExternalMediaTarget, allow: boolean | null) => {
      const outcome = await action.run((api) => api("SetExternalMedia", { target, allow }), ["externalMedia"])
      if (outcome.ok) channel?.postMessage("changed")
      return outcome
    }
  }
}
/** Used by the loaded-window stylesheet to invalidate offscreen consented resources. */
export function useExternalMediaRevision() {
  return JSON.stringify(useExternalMedia().prefs)
}
const MediaChat = createContext<ChatSession | null>(null)
export function ExternalMediaProvider({ session, children }: ChatSurfaceProps & { children: ReactNode }) {
  return <MediaChat value={session}>{children}</MediaChat>
}
export function useMediaPermit(speaker: EntityId | null, placement: 1 | 2): MediaPermit {
  const session = useContext(MediaChat)
  const media = useExternalMedia()
  const { cast } = useDisplayContext()
  const card = messageCharacter(cast, speaker, placement)
  const chat = session?.chatId ?? null
  const scope =
    media.ready && externalMediaAllowed(media.prefs, chat, card) && (chat || card)
      ? new URLSearchParams({ ...(chat ? { chat } : {}), ...(card ? { card } : {}) }).toString()
      : null
  return useMemo(
    () => ({
      scope,
      pending: !media.ready || media.pending,
      error: media.error?.message ?? null,
      actions: [
        ...(card && (chat === null || media.prefs.chats[chat] !== false)
          ? [
              {
                label: "Allow for this card",
                about: "Let images and audio from this card load from other sites.",
                allow: () => media.change({ _tag: "Card", id: card }, true)
              }
            ]
          : []),
        ...(chat
          ? [
              {
                label: "Allow for this chat",
                about: "Let images and audio in this chat load from other sites.",
                allow: () => media.change({ _tag: "Chat", id: chat }, true)
              }
            ]
          : [])
      ]
    }),
    [scope, media, card, chat]
  )
}
export function ExternalMediaDefault() {
  const media = useExternalMedia()
  return (
    <div className="flex flex-col gap-2">
      <Switch
        checked={media.prefs.default}
        disabled={!media.ready || media.pending}
        onCheckedChange={(on) => void media.change({ _tag: "Default" }, on)}
        about="Load images and audio from other sites unless a card or chat overrides this. Those sites receive a request when media loads."
      >
        Images from other sites
      </Switch>
      <ErrorAlert error={media.error} />
    </div>
  )
}
export function ExternalMediaChoice({
  target,
  label
}: {
  target: Exclude<ExternalMediaTarget, { _tag: "Default" }>
  label: string
}) {
  const media = useExternalMedia()
  const choice = media.prefs[target._tag === "Card" ? "cards" : "chats"][target.id]
  return (
    <div className="flex flex-col gap-2">
      <Field
        label={label}
        about="Images and audio load through this app. Loading them contacts the other site. A chat's choice takes priority over a card's."
      >
        <Select<string>
          value={choice === undefined ? "default" : choice ? "allow" : "block"}
          disabled={!media.ready || media.pending}
          onValueChange={(value) => void media.change(target, value === "default" ? null : value === "allow")}
          items={[
            { value: "default", label: "Use the default" },
            { value: "block", label: "Block" },
            { value: "allow", label: "Allow" }
          ]}
        />
      </Field>
      <ErrorAlert error={media.error} />
    </div>
  )
}
export function ChatExternalMedia({ session }: { session: ChatSession }) {
  return (
    <ExternalMediaChoice target={{ _tag: "Chat", id: session.chatId }} label="Images from other sites in this chat" />
  )
}
