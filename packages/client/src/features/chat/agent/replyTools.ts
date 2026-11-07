// Registered tools for the independent Tools setting and Model may change list.
import type { ReplyTools } from "@rp/shared/agent.ts"
import { useEffect, useState } from "react"
import type { ChatSession } from "../session.ts"

/** Read once a page: they change only when plugins do. */
let known: Promise<ReplyTools | string> | null = null
const readTools = (session: ChatSession) =>
  (known ??= session
    .call((client) => client("ListReplyTools", {}))
    .then((result) => {
      if (result.ok) return result.value
      known = null
      return `The tools couldn't be read: ${result.error.message}`
    }))

export function useReplyTools(session: ChatSession) {
  const [tools, setTools] = useState<ReplyTools | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void readTools(session).then((result) => {
      if (!active) return
      if (typeof result === "string") setError(result)
      else setTools(result)
    })
    return () => {
      active = false
    }
  }, [session])
  return { tools, error }
}
