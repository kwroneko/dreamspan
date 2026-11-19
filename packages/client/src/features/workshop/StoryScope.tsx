// Branch naming in an approval or saved change follows the branch menu after a rename.
// A deleted branch keeps its last saved display name; its identity is never printed.
import type { ChatId, StoryAt } from "@dreamspan/shared/chat.ts"
import { storyScopeText, type StoryScope as Scope } from "@dreamspan/shared/branchNaming.ts"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { AsyncResult, Atom } from "effect/reactivity"
import { useEffect } from "react"
import { AppClient } from "../../rpc.ts"
import { useForksVersion } from "../chat/forks.ts"

const branches = Atom.family((chatId: ChatId) =>
  AppClient.query("ListForks", { chatId }, { reactivityKeys: ["chats", chatId] })
)

export function StoryScope({ scope, at }: { scope: Scope; at?: Pick<StoryAt, "chatId" | "forkId"> | undefined }) {
  return at ? <LiveScope scope={scope} at={at} /> : <>{storyScopeText(scope)}</>
}

function LiveScope({ scope, at }: { scope: Scope; at: Pick<StoryAt, "chatId" | "forkId"> }) {
  const atom = branches(at.chatId)
  const result = useAtomValue(atom)
  const refresh = useAtomRefresh(atom)
  const bump = useForksVersion(at.chatId)
  useEffect(() => {
    refresh()
    window.addEventListener("focus", refresh)
    return () => window.removeEventListener("focus", refresh)
  }, [bump, refresh])
  const fork = AsyncResult.isSuccess(result) ? result.value.find((f) => f.id === at.forkId) : undefined
  const current = fork
    ? {
        ...scope,
        branch: { name: fork.name, original: fork.parentForkId === null, split: fork.split, createdAt: fork.createdAt }
      }
    : scope
  return (
    <>
      {storyScopeText(current)}
      {AsyncResult.isSuccess(result) && !fork ? " (deleted)" : ""}
    </>
  )
}
