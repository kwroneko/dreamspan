// Notifications (DESIGN §10.1, CLIENT-FRAMEWORK R13): a reply that finishes in a chat the user
// isn't looking at (another chat, or this tab hidden) counts as unseen until they open it. The
// chat list shows a badge per chat, and the tab's title and icon say how many there are. A
// system notification as well is the user's choice in settings: this page asks the browser
// for permission only when they turn it on, never by itself.
//
// Unseen counts belong to this tab and go with a reload.
import {
  activateNoticeChannels,
  NoticeChannelSettings,
  noticeDeduplicator,
  receiveUserNotice,
  receiveNoticeChannels
} from "./noticeContributions.tsx"
import { RegistryContext } from "@effect/atom-react"
import type { ChatId } from "@rp/shared/chat.ts"
import type { Notice } from "@rp/shared/noticeApi.ts"
import { useNavigate } from "@tanstack/react-router"
import { Cause, Context, Effect, Fiber, Schedule, Stream } from "effect"
import { AtomRegistry } from "effect/reactivity"
import { useContext, useEffect, useState, useSyncExternalStore } from "react"
import { routes } from "../routes.tsx"
import { AppClient } from "../rpc.ts"
import { Switch } from "../ui/Choice.tsx"
import { Alert, Card, CardHeader } from "../ui/Surface.tsx"

const firstNotice = noticeDeduplicator()
const unseen = new Map<ChatId, number>()
const listeners = new Set<() => void>()
/** The chat open in this tab, if any. */
let open: ChatId | null = null
let pageTitle = "rp-harness"

const total = () => [...unseen.values()].reduce((sum, n) => sum + n, 0)

const looking = (chatId: ChatId) => chatId === open && document.visibilityState === "visible"

/** The tab's title and icon say how many replies are unseen. */
const render = () => {
  const count = total()
  document.title = count > 0 ? `(${count}) ${pageTitle}` : pageTitle
  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (icon !== null) icon.href = count > 0 ? "/favicon-unseen.svg" : "/favicon.svg"
  for (const listener of listeners) listener()
}

/** The page's own title; the unseen count goes in front of it. */
export const setPageTitle = (title: string) => {
  pageTitle = title
  render()
}

const seen = (chatId: ChatId) => {
  if (unseen.delete(chatId)) render()
}

/** The chat this tab shows (null: none). Opening it, with the tab visible, sees its replies. */
export const useLookingAt = (chatId: ChatId) =>
  useEffect(() => {
    open = chatId
    if (document.visibilityState === "visible") seen(chatId)
    return () => {
      if (open === chatId) open = null
    }
  }, [chatId])

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** How many finished replies in this chat are unseen. */
export const useUnseen = (chatId: ChatId) => useSyncExternalStore(subscribe, () => unseen.get(chatId) ?? 0)

// --- System notifications, the user's choice per browser

const SYSTEM_KEY = "rp.notifications.system"

const systemWanted = () => {
  try {
    return localStorage.getItem(SYSTEM_KEY) === "on"
  } catch {
    return false
  }
}

const canNotify = () => typeof Notification !== "undefined"

// --- Receiving

/**
 * Listens for the user's notices while the app is open, and after a dropped socket again.
 * A system notification, if the user turned them on, opens its chat when clicked.
 */
export const useNotices = () => {
  const registry = useContext(RegistryContext)
  const navigate = useNavigate()
  useEffect(() => {
    const onVisible = () => {
      if (open !== null && document.visibilityState === "visible") seen(open)
    }
    document.addEventListener("visibilitychange", onVisible)
    document.addEventListener("click", activateNoticeChannels)
    document.addEventListener("keydown", activateNoticeChannels)
    const receive = (notice: Notice, client: AppClient["Service"]) =>
      Effect.gen(function* () {
        receiveUserNotice(notice)
        if (notice._tag !== "ReplyFinished") return
        if (!firstNotice(notice) || looking(notice.chatId)) return
        unseen.set(notice.chatId, (unseen.get(notice.chatId) ?? 0) + 1)
        render()
        receiveNoticeChannels(notice)
        if (!systemWanted() || !canNotify() || Notification.permission !== "granted") return
        const chat = yield* Effect.option(client("GetChat", { chatId: notice.chatId }))
        const name = chat._tag === "Some" ? chat.value.title || "Untitled chat" : "A chat"
        const shown = new Notification(notice.status === "failed" ? "A reply failed" : "A reply finished", {
          body: name,
          tag: notice.chatId
        })
        shown.onclick = () => {
          window.focus()
          void navigate({ to: "/chats/$chatId", params: { chatId: notice.chatId } })
          shown.close()
        }
      })
    const fiber = Effect.runFork(
      Effect.flatMap(AtomRegistry.getResult(registry, AppClient.runtime), (services) => {
        const client = Context.get(services, AppClient)
        return client("SubscribeNotices", undefined).pipe(
          Stream.runForEach((batch) => Effect.forEach(batch, (notice) => receive(notice, client), { discard: true }))
        )
      }).pipe(
        // A dropped socket ends the stream: listen again.
        Effect.retry({ schedule: Schedule.spaced("1 second") }),
        Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logWarning(cause)))
      )
    )
    return () => {
      document.removeEventListener("visibilitychange", onVisible)
      document.removeEventListener("click", activateNoticeChannels)
      document.removeEventListener("keydown", activateNoticeChannels)
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [registry, navigate])
}

// --- Settings

function NotificationSettings() {
  useEffect(() => setPageTitle("Notifications · rp-harness"), [])
  const [on, setOn] = useState(() => systemWanted() && canNotify() && Notification.permission === "granted")
  const [refused, setRefused] = useState(false)
  const toggle = async (next: boolean) => {
    setRefused(false)
    if (!next) {
      setOn(false)
      try {
        localStorage.removeItem(SYSTEM_KEY)
      } catch {
        // Nothing stored, then.
      }
      return
    }
    // Asked only now, as the user turns it on.
    const permission = await Notification.requestPermission()
    if (permission !== "granted") return setRefused(true)
    try {
      localStorage.setItem(SYSTEM_KEY, "on")
    } catch {
      // Can't be remembered in this browser.
    }
    setOn(true)
  }
  return (
    <Card>
      <CardHeader
        title="Notifications"
        about="See when a reply finishes in a chat you aren't looking at: a badge in the chat list, and a count in the tab's title and icon."
      />
      <div className="flex flex-col gap-3">
        <NoticeChannelSettings />
        {canNotify() ? (
          <Switch
            checked={on}
            onCheckedChange={(next) => void toggle(next)}
            about="In this browser only. It asks for the browser's permission when you turn it on."
          >
            System notifications as well
          </Switch>
        ) : (
          <Alert>This browser can't show system notifications.</Alert>
        )}
        {refused && (
          <Alert tone="warning" title="The browser didn't allow notifications">
            Allow them for this site in the browser's settings, then turn this on again.
          </Alert>
        )}
      </div>
    </Card>
  )
}

export const register = () => {
  routes.register({
    id: "settings.notifications",
    parent: "settings",
    path: "notifications",
    component: NotificationSettings,
    nav: {
      label: "Notifications",
      order: 45,
      description: "How you hear of a reply that finishes in a chat you aren't looking at."
    }
  })
}
