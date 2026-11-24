// Synchronous pending-composer recovery: IndexedDB and the server can both lag a reload.
// The original draft/version travels with the keystroke; server acknowledgements remove it.
import { copiesOf, keepCopy, pendingOf, type Copy } from "./backup.ts"

const key = (userId: string, targetId: string) => `dreamspan.pendingTyped:${userId}:${targetId}`
const hasTypedBackup = (targetId: string, field: string) =>
  field === "First message" &&
  (targetId.startsWith("pending-chat:") ||
    targetId.startsWith("pending-group-chat:") ||
    targetId.startsWith("pending-workshop:"))

export const readTypedBackup = (userId: string, targetId: string): Copy | null => {
  try {
    const copy: Copy | { at: number; content: string } | null = JSON.parse(
      localStorage.getItem(key(userId, targetId)) ?? "null"
    )
    // Before versioned backups, this key held only a time and text. Deletion barriers
    // reject that unversioned copy; the legacy time rule applies otherwise.
    if (copy && !("save" in copy))
      return {
        // Its owner and draft too: two such backups of the same moment are two copies (rev-dd3 #3).
        key: `legacy:${userId}:${targetId}:${copy.at}`,
        userId,
        refId: targetId,
        field: "First message",
        content: copy.content,
        at: copy.at,
        ancestors: [],
        save: {
          kind: "userDraft",
          payload: {
            ownerId: userId as import("@dreamspan/shared/domain.ts").UserId,
            targetId,
            field: "First message",
            content: copy.content,
            draftId: null,
            expectedRowVersion: null,
            expectedSession: null
          }
        }
      }
    return copy?.userId === userId && copy.refId === targetId && pendingOf(copy)?.kind === "userDraft" ? copy : null
  } catch {
    return null
  }
}
export const keepTypedBackup = (copy: Copy) => {
  if (!hasTypedBackup(copy.refId, copy.field)) return
  try {
    localStorage.setItem(key(copy.userId, copy.refId), JSON.stringify(copy))
  } catch {
    // IndexedDB and the server still keep the text.
  }
}
export const dropTypedBackup = (copy: Copy) => {
  try {
    if (readTypedBackup(copy.userId, copy.refId)?.key === copy.key)
      localStorage.removeItem(key(copy.userId, copy.refId))
  } catch {
    // A later opening can acknowledge it again.
  }
}

/**
 * The old pages' typed backups of this user, moved into the browser copies (rev-dfu1 #7): no
 * page opens their keys now, so Browser recovery lists them and Retry saving sends them (the
 * server files them to recovered texts). Each leaves localStorage only once its exact copy is
 * read back from IndexedDB (a put that IndexedDB couldn't make keeps it: rev-dd3 #1), and only
 * while localStorage still holds that copy, not newer text another tab wrote since (#2).
 */
export const adoptTypedBackups = async (userId: string) => {
  const prefix = `dreamspan.pendingTyped:${userId}:`
  const keys: Array<string> = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i)
      if (name?.startsWith(prefix)) keys.push(name)
    }
  } catch {
    return
  }
  for (const name of keys) {
    const copy = readTypedBackup(userId, name.slice(prefix.length))
    if (copy === null) continue
    try {
      const has = async () => (await copiesOf(userId, copy.refId)).some((there) => there.key === copy.key)
      if (!(await has())) await keepCopy(copy)
      if (await has()) dropTypedBackup(copy)
    } catch {
      // Kept for the next opening.
    }
  }
}
