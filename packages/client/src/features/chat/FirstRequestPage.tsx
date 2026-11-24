// /request/first: the first request of a chat not sent yet (DESIGN §2.1), as a request
// inspector tab (owner, 2026-11-23). Its pending chat's view builds it (`useDraftPreview`, with
// `PreviewChat`: nothing written, nothing asked of a provider) and publishes it (firstRequest.ts);
// this page only shows it, so it sends nothing either.
import { useNavigate, useSearch } from "@tanstack/react-router"
import { lazy, Suspense, useSyncExternalStore } from "react"
import { CenterHeaderContent } from "../../ui/CenterHeader.tsx"
import { openOnPlainClick } from "../../ui/links.ts"
import { Loading } from "../../ui/Spinner.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { useTitle } from "../shell.tsx"
import { findTab } from "../workbench/model.ts"
import { useWorkbenchTab } from "../workbench/tab.tsx"
import { firstRequestOf, firstRequests } from "./firstRequest.ts"

const DraftRequestView = lazy(() => import("./ContextPage.tsx").then((m) => ({ default: m.DraftRequestView })))

export function FirstRequestPage() {
  const { pending, tab: pendingTab } = firstRequestOf(useSearch({ strict: false }))
  useTitle("Your first request")
  useSyncExternalStore(firstRequests.subscribe, firstRequests.version)
  const draft = pending === null ? null : firstRequests.find(pending, pendingTab)
  const request = draft?.preview?.request ?? null
  const navigate = useNavigate()
  const tab = useWorkbenchTab()
  // Back to the new chat's own view, wherever it is: another view of it would start over.
  const back = () => {
    if (pending === null) return
    const own = tab && pendingTab ? findTab(tab.store.layout, pendingTab) : undefined
    if (tab && own) tab.store.focusTab(own.id)
    else void navigate({ href: pending })
  }
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <CenterHeaderContent>
          <h1 className="text-lg font-semibold">Your first request</h1>
        </CenterHeaderContent>
        <p className="text-sm text-muted">
          An approximate preview of your first request. Random choices, the current time and automatic decisions can
          change it when you send. Nothing has been sent.
        </p>
      </header>
      {pending !== null && (
        <Tooltip label="Returns to the new chat.">
          <a href={pending} onClick={openOnPlainClick(back)} className="self-start text-sm text-muted hover:text-text">
            ← Back to the new chat
          </a>
        </Tooltip>
      )}
      {request !== null ? (
        <Suspense fallback={<Loading label="Loading the request…" />}>
          <DraftRequestView request={request} />
        </Suspense>
      ) : draft === null ? (
        <p className="text-sm">The new chat this request is for isn't open. Open it to see its first request.</p>
      ) : draft.loading ? (
        <Loading label="Building the request…" />
      ) : (
        <p className="text-sm">
          {draft.error ?? draft.preview?.assemblyError ?? "Choose a model for this chat to see its first request."}
        </p>
      )}
    </div>
  )
}
