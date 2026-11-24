// This chat's own cover image (DESIGN §2.1; ARCHITECTURE §12 "A chat's own picture"): optional,
// shown wherever the chat is listed or headed in place of its characters' portraits. A registered
// section of This chat (`chatSettingSections`), under who you play. The image is the chat's,
// as its name is: every branch of the chat shows it, and a chat split off has its own.
import type { ChatId } from "@dreamspan/shared/chat.ts"
import { useRef, useState, useSyncExternalStore } from "react"
import { Avatar } from "../../ui/Avatar.tsx"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { PICTURE_ACCEPT } from "../../ui/portraitParts.ts"
import { showToast } from "../../ui/Toast.tsx"
import { castCharacters, chatDisplayName } from "./chatTitle.ts"
import type { ChatSession } from "./session.ts"
import { useSplitChats } from "./splitChats.ts"

/** Sends an image as a message's attachment is sent (`POST /chat/image`: its types and its size limit). */
const upload = async (file: Blob): Promise<{ mediaId: string } | { error: string }> => {
  const response = await fetch("/chat/image", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: file
  }).catch(() => null)
  if (!response) return { error: "The image couldn’t be sent: check the connection and try again." }
  const body = (await response.json().catch(() => ({}))) as { mediaId?: unknown; error?: unknown }
  if (response.ok && typeof body.mediaId === "string") return { mediaId: body.mediaId }
  return { error: typeof body.error === "string" ? body.error : "The image couldn’t be uploaded." }
}

export function ChatPictureSetting({ session }: { session: ChatSession }) {
  const view = useSyncExternalStore(session.subscribe, session.snapshot)
  const split = useSplitChats(view.chat?.id ?? null, view.forkId)
  const picker = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chatId = (split?.group.id ?? null) as ChatId | null
  const picture = split?.group.picture ?? null
  const name = chatDisplayName(view)
  // The owner's wording: "The character's portraits", plural when the chat has several.
  const portraits = castCharacters(view).length === 1 ? "character’s portraits" : "characters’ portraits"

  /** Sets or removes it; `undo` offers the image before, once. */
  const set = async (mediaId: string | null, undo: boolean) => {
    if (chatId === null) return
    const result = await session.setPicture(chatId, mediaId)
    if (!result.ok) return setError(result.error.message)
    setError(null)
    const { previous } = result.value
    if (undo && previous !== mediaId)
      showToast({
        title: mediaId === null ? "Cover image removed" : previous === null ? "Cover image set" : "Cover image changed",
        actions: [
          {
            label: "Undo",
            hint: previous === null ? `Goes back to the ${portraits}.` : "Puts the image before back.",
            onClick: () => void set(previous, false)
          }
        ]
      })
  }
  const pick = async (file: File | undefined) => {
    if (!file) return
    setPending(true)
    setError(null)
    const sent = await upload(file)
    if ("error" in sent) setError(sent.error)
    else await set(sent.mediaId, true)
    setPending(false)
  }
  return (
    <section aria-label="Chat cover image" className="flex flex-col gap-2">
      <div
        role="group"
        aria-label="Chat cover image"
        className="flex max-w-controls flex-wrap items-center gap-x-3 gap-y-2"
      >
        {picture !== null && chatId !== null ? (
          <Avatar id={chatId} name={name} mediaId={picture} size="lg" preview />
        ) : (
          // The same box without an image, so picking one moves nothing.
          <span
            aria-hidden="true"
            className="inline-flex h-15 w-10 shrink-0 items-center justify-center rounded-sm border border-dashed border-border text-muted"
          >
            <Icon name="image" size={16} />
          </span>
        )}
        <div className="flex min-w-28 flex-1 flex-col">
          <span className="text-xs text-muted">Cover Image for this chat</span>
          <span className="font-medium [overflow-wrap:anywhere]">
            {picture !== null ? "Custom image" : `The ${portraits}`}
          </span>
        </div>
        <Button
          hint={
            picture !== null
              ? "Picks another cover image for this chat. PNG, JPEG, GIF or WebP, up to 16 MB."
              : `Picks a cover image shown for this chat in lists and its header, on every branch, in place of the ${portraits}. PNG, JPEG, GIF or WebP, up to 16 MB.`
          }
          disabled={chatId === null}
          pending={pending}
          onClick={() => picker.current?.click()}
        >
          {picture !== null ? "Change" : "Pick custom image"}
        </Button>
        {picture !== null && (
          <Button
            variant="ghost"
            hint={`Goes back to the ${portraits}. The image stays in the chat’s messages if it was used there.`}
            disabled={pending}
            onClick={() => void set(null, true)}
          >
            Remove
          </Button>
        )}
        <input
          ref={picker}
          type="file"
          accept={PICTURE_ACCEPT}
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          data-chat-picture-picker
          onChange={(event) => {
            void pick(event.currentTarget.files?.[0])
            event.currentTarget.value = ""
          }}
        />
      </div>
      {error !== null && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  )
}
