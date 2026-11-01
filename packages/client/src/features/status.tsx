import { useAtomRefresh } from "@effect/atom-react"
import { useEffect } from "react"
import { AsyncView } from "../actions.tsx"
import { routes } from "../routes.tsx"
import { AppClient } from "../rpc.ts"
import { useSession } from "../session.ts"
import { Card, CardHeader } from "../ui/Surface.tsx"
import { useTitle } from "./shell.tsx"

const healthAtom = AppClient.query("Health", undefined)

/** An event-loop delay that users feel. */
const SLOW_MS = 50

const duration = (ms: number) => {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return "less than a minute"
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const parts = [
    days > 0 ? `${days} d` : null,
    hours > 0 ? `${hours} h` : null,
    days === 0 ? `${minutes % 60} min` : null
  ]
  return parts.filter((part) => part !== null).join(" ")
}

function Status() {
  useTitle("Server status")
  const { user } = useSession()
  const refreshHealth = useAtomRefresh(healthAtom)

  useEffect(() => {
    const timer = setInterval(refreshHealth, 2000)
    return () => clearInterval(timer)
  }, [refreshHealth])

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <AsyncView atom={healthAtom} loading="Connecting…">
        {(health) => {
          const slow = health.eventLoopP99Ms > SLOW_MS
          return (
            <>
              <Card>
                <CardHeader title="Server" description={`Signed in as ${user.displayName} (${user.role}).`} />
                <p className="mb-3 flex items-start gap-2 text-sm">
                  <span
                    aria-hidden="true"
                    className={`mt-1.5 size-2 shrink-0 rounded-full ${slow ? "bg-warning" : "bg-success"}`}
                  />
                  {slow ? "Running, but busy: replies and pages may be slow." : "Running normally."}
                </p>
                <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
                  <dt className="text-muted">Version</dt>
                  <dd>{health.version}</dd>
                  <dt className="text-muted">Up for</dt>
                  <dd>{duration(health.uptimeMs)}</dd>
                </dl>
              </Card>
              {user.role === "admin" && (
                <Card>
                  <CardHeader
                    title="Admin diagnostics"
                    description={`The server's main thread over the last minute. Delays above ${SLOW_MS} ms make the app slow for everyone.`}
                  />
                  <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
                    <dt className="text-muted">Event loop p99</dt>
                    <dd className={slow ? "text-danger" : "text-success"}>{health.eventLoopP99Ms} ms</dd>
                    <dt className="text-muted">Event loop max</dt>
                    <dd className={health.eventLoopMaxMs > SLOW_MS ? "text-danger" : "text-success"}>
                      {health.eventLoopMaxMs} ms
                    </dd>
                    <dt className="text-muted">Database readers</dt>
                    <dd>{health.readers}</dd>
                  </dl>
                </Card>
              )}
            </>
          )
        }}
      </AsyncView>
    </div>
  )
}

export const register = () => {
  // The server's health, a settings page since the home screen is the characters. Everyone
  // sees whether it's running well; the numbers behind that are for admins.
  routes.register({
    id: "settings.status",
    parent: "settings",
    path: "status",
    component: Status,
    nav: { label: "Server status", order: 80, description: "The server's version, and diagnostics for admins." }
  })
}
