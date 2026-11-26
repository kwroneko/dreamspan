import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { autoUpdateMessages, type UpdateStatus } from "@dreamspan/shared/updates.ts"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useState, useSyncExternalStore } from "react"
import { AsyncView, ErrorAlert, useAction } from "../../actions.tsx"
import { copyText } from "../../copyText.ts"
import type { AppError } from "../../errors.ts"
import { AppClient } from "../../rpc.ts"
import { useSession } from "../../session.ts"
import { reloadApp } from "../../staleBuild.tsx"
import { Button } from "../../ui/Button.tsx"
import { Card, CardHeader, Disclosure } from "../../ui/Surface.tsx"
import { IconButton } from "../../ui/Tooltip.tsx"
import { appBanners } from "../shell.tsx"

const statusAtom = AppClient.query("GetUpdateStatus", undefined)
const dismissKey = "dreamspan.updateDismissedCommit"

const readDismissed = () => {
  try {
    return localStorage.getItem(dismissKey)
  } catch {
    return null
  }
}

type UpdateProgress =
  { readonly phase: "idle"; readonly error?: AppError } | { readonly phase: "updating" | "restarting" }

let progress: UpdateProgress = { phase: "idle" }
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
const getProgress = () => progress
const setProgress = (next: UpdateProgress) => {
  progress = next
  for (const listener of listeners) listener()
}

const health = async () => {
  try {
    const response = await fetch("/healthz", { cache: "no-store", signal: AbortSignal.timeout(3_000) })
    if (response.ok)
      return { commit: response.headers.get("x-app-commit"), build: response.headers.get("x-client-build") }
  } catch {
    // The server stops answering while the supervisor brings it back.
  }
  return null
}

const waitForRestart = async (target: string, previousBuild: string | null) => {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 1_000))
    const current = await health()
    if (
      current &&
      (current.commit
        ? target.startsWith(current.commit)
        : previousBuild && current.build && current.build !== previousBuild)
    ) {
      await reloadApp()
      return
    }
  }
  setProgress({
    phase: "idle",
    error: {
      tag: "RestartTimeout",
      message: "Dreamspan took too long to restart. Check the server before trying again.",
      reason: null,
      problems: []
    }
  })
}

function UpdateButton({ status }: { status: UpdateStatus }) {
  const current = useSyncExternalStore(subscribe, getProgress, getProgress)
  const action = useAction()
  const refresh = useAtomRefresh(statusAtom)
  const phase = current.phase === "idle" ? status.state : current.phase
  const pending = phase === "updating" || phase === "restarting"
  const apply = async () => {
    if (progress.phase !== "idle") return
    setProgress({ phase: "updating" })
    const previous = await health()
    const result = await action.run((client) => client("ApplyServerUpdate", undefined))
    if (!result.ok) {
      setProgress({ phase: "idle", error: result.error })
      refresh()
      return
    }
    setProgress({ phase: "restarting" })
    await waitForRestart(result.value.targetCommit, previous?.build ?? null)
    refresh()
  }
  return (
    <>
      {(status.canAutoUpdate || pending) && (
        <Button
          variant="primary"
          disabled={phase === "checking"}
          pending={pending}
          hint="Installs the update, restarts the server for everyone, and reloads this tab."
          onClick={() => void apply()}
        >
          {phase === "restarting" ? "Restarting Dreamspan…" : pending ? "Updating…" : "Update & restart"}
        </Button>
      )}
      {current.phase === "idle" && current.error && <ErrorAlert error={current.error} />}
    </>
  )
}

function IncomingCommits({ status }: { status: UpdateStatus }) {
  if (status.incoming.length === 0) return null
  return (
    <ul className="space-y-1 text-sm text-muted [overflow-wrap:anywhere]">
      {status.incoming.map(({ commit, subject }) => (
        <li key={commit}>
          <code className="mr-2 text-xs">{commit}</code>
          {subject}
        </li>
      ))}
    </ul>
  )
}

function ManualUpdate({ reason }: { reason: NonNullable<UpdateStatus["autoUpdateReason"]> }) {
  const command =
    reason === "not_git" ? "git pull --ff-only && docker compose up -d --build" : "git pull --ff-only && npm run build"
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-muted">{autoUpdateMessages[reason]}</p>
      {reason !== "check_failed" && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <code className="select-all text-xs [overflow-wrap:anywhere]">{command}</code>
          <Button
            variant="ghost"
            size="chip"
            hint="Copies the command for updating from your terminal."
            onClick={() => {
              void copyText(command).then(
                () => {
                  setCopied(true)
                  setCopyFailed(false)
                },
                () => setCopyFailed(true)
              )
            }}
          >
            {copied ? "Copied" : "Copy command"}
          </Button>
          {copyFailed && <span role="status">Select the command to copy it.</span>}
        </div>
      )}
    </div>
  )
}

function AdminUpdateRibbon() {
  const result = useAtomValue(statusAtom)
  const refresh = useAtomRefresh(statusAtom)
  const [dismissed, setDismissed] = useState(readDismissed)
  useEffect(() => {
    const timer = setInterval(refresh, 10_000)
    window.addEventListener("focus", refresh)
    window.addEventListener("rp:connected", refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener("focus", refresh)
      window.removeEventListener("rp:connected", refresh)
    }
  }, [refresh])
  if (!AsyncResult.isSuccess(result)) return null
  const status = result.value
  const target = status.remoteCommit
  if (status.behindCount === 0 || target === null || target === dismissed) return null
  return (
    <section
      aria-label="Dreamspan update"
      className="flex shrink-0 items-start gap-2 border-b border-border bg-surface-raised px-3 py-2 text-sm sm:px-4"
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 grow">
          <p className="font-medium">{updateCount(status.behindCount)}</p>
          {status.incoming.length > 0 && (
            <Disclosure title="Incoming commits" className="w-fit max-w-full">
              <IncomingCommits status={status} />
            </Disclosure>
          )}
          {!status.canAutoUpdate && status.state === "idle" && status.autoUpdateReason && (
            <ManualUpdate key={target} reason={status.autoUpdateReason} />
          )}
        </div>
        <UpdateButton status={status} />
      </div>
      <IconButton
        icon="close"
        className="shrink-0"
        label="Dismiss update"
        hint="Hides this notice until a newer update is available."
        onClick={() => {
          setDismissed(target)
          try {
            localStorage.setItem(dismissKey, target)
          } catch {
            // The notice stays dismissed in this tab when browser storage is unavailable.
          }
        }}
      />
    </section>
  )
}

const updateCount = (count: number) => `Update available (${count} new ${count === 1 ? "commit" : "commits"})`

function UpdateRibbon() {
  return useSession().user.role === "admin" ? <AdminUpdateRibbon /> : null
}

function UpdateDetails({ status }: { status: UpdateStatus }) {
  const check = useAction()
  const refresh = useAtomRefresh(statusAtom)
  const update = useSyncExternalStore(subscribe, getProgress, getProgress)
  const pending = check.pending || status.state === "checking"
  const checked = status.lastCheckedAt
  const summary = status.lastError
    ? status.lastError
    : status.autoUpdateReason === "not_git"
      ? autoUpdateMessages.not_git
      : status.behindCount > 0
        ? updateCount(status.behindCount)
        : checked === null
          ? "No check yet."
          : `No incoming commits on ${status.branch}.`
  return (
    <div className="space-y-3 text-sm">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
        <dt className="text-muted">Current commit</dt>
        <dd>{status.currentCommit ? <code>{status.currentCommit}</code> : "Unavailable"}</dd>
        <dt className="text-muted">Status</dt>
        <dd className="[overflow-wrap:anywhere]">{summary}</dd>
        <dt className="text-muted">Last checked</dt>
        <dd>{checked === null ? "Never" : new Date(checked).toLocaleString()}</dd>
        <dt className="text-muted">Automatic checks</dt>
        <dd>{status.automaticChecks ? "On" : "Off"}</dd>
      </dl>
      <IncomingCommits status={status} />
      {!status.canAutoUpdate && status.state === "idle" && status.behindCount > 0 && status.autoUpdateReason && (
        <ManualUpdate key={status.remoteCommit} reason={status.autoUpdateReason} />
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          hint="Checks the configured Git branch for new commits."
          pending={pending}
          disabled={update.phase !== "idle" || status.state !== "idle" || status.autoUpdateReason === "not_git"}
          onClick={() => {
            void check.run((client) => client("CheckForUpdates", undefined)).then(refresh)
          }}
        >
          Check now
        </Button>
        <UpdateButton status={status} />
      </div>
      <ErrorAlert error={check.error} />
    </div>
  )
}

export function UpdatesCard() {
  return (
    <Card>
      <CardHeader title="Updates" />
      <AsyncView atom={statusAtom} loading="Loading update status…">
        {(status) => <UpdateDetails status={status} />}
      </AsyncView>
    </Card>
  )
}

export const register = () => appBanners.register({ id: "server.updates", order: 9, component: UpdateRibbon })
