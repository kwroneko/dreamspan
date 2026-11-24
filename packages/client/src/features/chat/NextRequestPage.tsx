// /request/next: a chat's next request (nextRequest.ts), as a request inspector tab. Built with
// `GetNextRequest` where the chat's open view stands, again whenever its estimate changes;
// assembled and counted locally, so nothing is sent.
import type { DraftRequest } from "@dreamspan/shared/inspectorApi.ts"
import { useSearch } from "@tanstack/react-router"
import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from "react"
import { CenterHeaderContent } from "../../ui/CenterHeader.tsx"
import { Loading } from "../../ui/Spinner.tsx"
import { useCaller } from "../editor/caller.ts"
import { useTitle } from "../shell.tsx"
import { nextRequestOf, nextRequests } from "./nextRequest.ts"

const DraftRequestView = lazy(() => import("./ContextPage.tsx").then((m) => ({ default: m.DraftRequestView })))

export function NextRequestPage() {
  const { chat, leaf, fork } = nextRequestOf(useSearch({ strict: false }))
  useTitle("Your next request")
  useSyncExternalStore(nextRequests.subscribe, nextRequests.version)
  const live = chat === null ? null : nextRequests.find(chat)
  const at = live ?? { leaf, fork, revision: null }
  const call = useCaller()
  const asked = JSON.stringify([chat, at.leaf, at.fork, at.revision])
  const [state, setState] = useState<{ asked: string | null; request: DraftRequest | null; error: string | null }>({
    asked: null,
    request: null,
    error: null
  })
  useEffect(() => {
    if (chat === null) return
    let current = true
    void call((client) => client("GetNextRequest", { chatId: chat, leafSlotId: at.leaf, forkId: at.fork })).then(
      (result) => {
        if (!current) return
        setState(
          result.ok
            ? { asked, request: result.value, error: null }
            : { asked, request: null, error: result.error.message }
        )
      }
    )
    return () => {
      current = false
    }
    // `asked` holds what the request depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, call])
  const fresh = state.asked === asked
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <CenterHeaderContent>
          <h1 className="text-lg font-semibold">Your next request</h1>
        </CenterHeaderContent>
        <p className="text-sm text-muted">
          Your next request as it would be sent now, before what you're typing. Random choices, the current time and
          automatic decisions can change it when you send. Nothing has been sent.
        </p>
      </header>
      {chat === null ? (
        <p className="text-sm">This link doesn't name a chat.</p>
      ) : state.request !== null ? (
        <div className={fresh ? "" : "opacity-60"}>
          <Suspense fallback={<Loading label="Loading the request…" />}>
            <DraftRequestView request={state.request} />
          </Suspense>
        </div>
      ) : !fresh ? (
        <Loading label="Building the request…" />
      ) : (
        <p className="text-sm">{state.error ?? "Choose a model for this chat to see its next request."}</p>
      )}
    </div>
  )
}
