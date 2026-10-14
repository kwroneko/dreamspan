import { useAtomRefresh } from "@effect/atom-react"
import { useEffect } from "react"
import { AsyncView } from "../actions.tsx"
import { routes } from "../routes.tsx"
import { AppClient } from "../rpc.ts"
import { useSession } from "../session.ts"
import { Card, CardHeader } from "../ui/Surface.tsx"
import { useTitle } from "./shell.tsx"

const healthAtom = AppClient.query("Health", undefined)

function Status() {
  useTitle("Status")
  const { user } = useSession()
  const refreshHealth = useAtomRefresh(healthAtom)

  useEffect(() => {
    const timer = setInterval(refreshHealth, 2000)
    return () => clearInterval(timer)
  }, [refreshHealth])

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <Card>
        <CardHeader title="Server status" description={`Signed in as ${user.displayName} (${user.role}).`} />
        <AsyncView atom={healthAtom} loading="Connecting…">
          {(health) => (
            <dl className="grid grid-cols-2 gap-y-1 text-sm">
              <dt className="text-muted">Version</dt>
              <dd>{health.version}</dd>
              <dt className="text-muted">Uptime</dt>
              <dd>{Math.round(health.uptimeMs / 1000)} s</dd>
              <dt className="text-muted">Event loop p99</dt>
              <dd className={health.eventLoopP99Ms > 50 ? "text-danger" : "text-success"}>
                {health.eventLoopP99Ms} ms
              </dd>
              <dt className="text-muted">Event loop max</dt>
              <dd className={health.eventLoopMaxMs > 50 ? "text-danger" : "text-success"}>
                {health.eventLoopMaxMs} ms
              </dd>
              <dt className="text-muted">Database readers</dt>
              <dd>{health.readers}</dd>
            </dl>
          )}
        </AsyncView>
      </Card>
    </div>
  )
}

export const register = () => {
  // The server's health, a settings section since the home screen is the characters.
  routes.register({
    id: "settings.status",
    parent: "settings",
    path: "status",
    component: Status,
    nav: { label: "Status", order: 80 }
  })
}
