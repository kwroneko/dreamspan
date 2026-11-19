import { useAtomRefresh } from "@effect/atom-react"
import { useEffect } from "react"
import { AsyncView } from "../actions.tsx"
import { routes } from "../routes.tsx"
import { AppClient } from "../rpc.ts"
import { useSession } from "../session.ts"
import { Card, CardHeader } from "../ui/Surface.tsx"
import { useTitle } from "./shell.tsx"

const healthAtom = AppClient.query("Health", undefined)
// Read once per visit: it changes only when the database writer starts again.
const databaseStartupAtom = AppClient.query("GetDatabaseStartup", undefined)

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
                <CardHeader center title="Server" description={`Signed in as ${user.displayName} (${user.role}).`} />
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
                  <DatabaseCheck />
                </Card>
              )}
            </>
          )
        }}
      </AsyncView>
    </div>
  )
}

/** What the database's reference check found when the server last started. */
function DatabaseCheck() {
  return (
    <div className="mt-4 text-sm">
      <AsyncView atom={databaseStartupAtom} loading="Checking the database…">
        {({ broken }) => {
          const rows = broken.reduce((sum, row) => sum + row.rows, 0)
          return (
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
              <dt className="text-muted">Database check</dt>
              {rows === 0 ? (
                <dd className="text-success">No problems found at start</dd>
              ) : (
                <dd className="flex min-w-0 flex-col gap-1">
                  <span className="text-danger">
                    {rows} {rows === 1 ? "record points at one that's" : "records point at ones that are"} missing
                  </span>
                  <span>
                    The server started anyway, but items that use them may not open or save. Restore a backup from
                    before this, or report it with the list below.
                  </span>
                  <ul className="text-muted break-words">
                    {broken.map((row) => (
                      <li key={`${row.table} ${row.parent}`}>
                        {row.rows} in {row.table}, pointing into {row.parent}
                      </li>
                    ))}
                  </ul>
                </dd>
              )}
            </dl>
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
