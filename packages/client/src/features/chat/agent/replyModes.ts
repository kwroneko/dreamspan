// The reply modes and tools the server has registered (`ListReplyModes`), for the chat settings'
// sections: the Reply mode and the Model may change list.
import type { ReplyModes } from "@rp/shared/agent.ts"
import { useEffect, useState } from "react"
import type { ChatSession } from "../session.ts"

export const PLAIN = "plain"

/** Read once a page: they change only when plugins do. */
let known: Promise<ReplyModes | string> | null = null
const readModes = (session: ChatSession) =>
  (known ??= session
    .call((client) => client("ListReplyModes", {}))
    .then((result) => {
      if (result.ok) return result.value
      known = null
      return `The reply modes couldn't be read: ${result.error.message}`
    }))

export function useReplyModes(session: ChatSession) {
  const [modes, setModes] = useState<ReplyModes | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void readModes(session).then((result) => {
      if (!active) return
      if (typeof result === "string") setError(result)
      else setModes(result)
    })
    return () => {
      active = false
    }
  }, [session])
  return { modes, error }
}
