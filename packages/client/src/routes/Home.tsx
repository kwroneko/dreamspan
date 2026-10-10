import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { Cause } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useEffect } from "react"
import { AppClient } from "../rpc.ts"
import { Button } from "../ui/Button.tsx"

const whoamiAtom = AppClient.query("Whoami", undefined)
const healthAtom = AppClient.query("Health", undefined)

export function Home() {
  const whoami = useAtomValue(whoamiAtom)
  const health = useAtomValue(healthAtom)
  const refreshHealth = useAtomRefresh(healthAtom)

  useEffect(() => {
    const timer = setInterval(refreshHealth, 2000)
    return () => clearInterval(timer)
  }, [refreshHealth])

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">rp-harness</h1>
        <p className="text-muted">Phase 0 scaffold. Nothing to chat with yet.</p>
      </header>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-2 text-sm font-medium text-muted">Signed in as</h2>
        {AsyncResult.match(whoami, {
          onInitial: () => <p className="text-muted">Connecting…</p>,
          onFailure: (failure) => <p className="text-danger">{Cause.pretty(failure.cause)}</p>,
          onSuccess: ({ value }) => (
            <p>
              {value.displayName} <span className="text-muted">({value.role})</span>
            </p>
          )
        })}
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted">Server</h2>
          <Button variant="ghost" onClick={refreshHealth}>
            Refresh
          </Button>
        </div>
        {AsyncResult.match(health, {
          onInitial: () => <p className="text-muted">Connecting…</p>,
          onFailure: (failure) => <p className="text-danger">{Cause.pretty(failure.cause)}</p>,
          onSuccess: ({ value }) => (
            <dl className="grid grid-cols-2 gap-y-1 text-sm">
              <dt className="text-muted">Version</dt>
              <dd>{value.version}</dd>
              <dt className="text-muted">Uptime</dt>
              <dd>{Math.round(value.uptimeMs / 1000)} s</dd>
              <dt className="text-muted">Event loop p99</dt>
              <dd className={value.eventLoopP99Ms > 50 ? "text-danger" : "text-success"}>{value.eventLoopP99Ms} ms</dd>
              <dt className="text-muted">Database readers</dt>
              <dd>{value.readers}</dd>
            </dl>
          )
        })}
      </section>
    </main>
  )
}
