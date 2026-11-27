import { useSyncExternalStore, type CSSProperties } from "react"
import type { DisplayPrefs } from "@dreamspan/shared/chatApi.ts"
import type { ChatId } from "@dreamspan/shared/chat.ts"
import { CHAT_BACKGROUND_MEDIA_ROUTE } from "@dreamspan/shared/chatBackgrounds.ts"

export const backgroundUrl = (mediaId: string) => `${CHAT_BACKGROUND_MEDIA_ROUTE}/${encodeURIComponent(mediaId)}`
export const activeBackground = (prefs: DisplayPrefs, chatId?: ChatId) => {
  const choice = chatId === undefined ? undefined : prefs.chatBackgrounds[chatId]
  return choice === undefined ? prefs.chatBackground.mediaId : choice
}

type Preview = { readonly opacity?: number; readonly blur?: number }
let preview: Preview | null = null
const listeners = new Set<() => void>()
export const previewBackground = (next: Preview | null) => {
  preview = next
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const snapshot = () => preview
export const useBackgroundPreview = () => useSyncExternalStore(subscribe, snapshot)

export function ChatBackdrop({ prefs, chatId }: { prefs: DisplayPrefs; chatId?: ChatId | undefined }) {
  const dragged = useBackgroundPreview()
  const mediaId = activeBackground(prefs, chatId)
  if (mediaId === null) return null
  const { fit, opacity, blur } = { ...prefs.chatBackground, ...dragged }
  return (
    <>
      <div className="chat-wallpaper" aria-hidden="true" data-chat-wallpaper={mediaId}>
        <div
          data-wallpaper-pixels
          data-fit={fit}
          style={
            {
              backgroundImage: `url("${backgroundUrl(mediaId)}")`,
              "--wallpaper-blur": `${blur}px`
            } as CSSProperties
          }
        />
      </div>
      <div
        aria-hidden="true"
        className="chat-column chat-reading-backdrop"
        data-chat-reading-backdrop
        style={{ "--reading-opacity": `${opacity}%` } as CSSProperties}
      />
    </>
  )
}
