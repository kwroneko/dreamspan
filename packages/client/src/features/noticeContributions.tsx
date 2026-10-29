import type { Notice } from "@rp/shared/noticeApi.ts"
import { type ComponentType, useSyncExternalStore } from "react"
import { makeRegistry } from "../registry.ts"

/** Optional ways to announce an unseen reply, with their settings and browser activation. */
export const noticeChannels = makeRegistry<{
  readonly id: string
  readonly component: ComponentType
  readonly activate: () => void
  readonly receive: (notice: Notice) => void
}>()

export function NoticeChannelSettings() {
  const snapshot = useSyncExternalStore(noticeChannels.subscribe, noticeChannels.snapshot, noticeChannels.snapshot)
  return snapshot.entries.map((channel) => <channel.component key={channel.id} />)
}

export const activateNoticeChannels = () => {
  for (const channel of noticeChannels.list()) channel.activate()
}

export const receiveNoticeChannels = (notice: Notice) => {
  for (const channel of noticeChannels.list()) channel.receive(notice)
}

/** Keep identities for this tab's lifetime, across subscription retries and remounts. */
export const noticeDeduplicator = () => {
  const received = new Set<string>()
  return (notice: { versionId: string; status: string }) => {
    const key = `${notice.versionId}:${notice.status}`
    if (received.has(key)) return false
    received.add(key)
    return true
  }
}
