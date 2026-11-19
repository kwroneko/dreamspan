// This chat → Tools → From MCP servers (spec/MCP.md §13.2): each of the user's servers on or off
// for replies on this branch (`agent.mcp`), over the account's Stories switch. A box shows the
// branch's choice, else the account's; Reset, shown only while the branch has a choice, goes back
// to the account's. Turning one on is the consent: its allowed tools then run without asking.
import { useAtomValue } from "@effect/atom-react"
import type { StoryMcpServer } from "@dreamspan/shared/mcpApi.ts"
import { Link } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useState } from "react"
import { AppClient } from "../../../rpc.ts"
import { Button } from "../../../ui/Button.tsx"
import { Checkbox } from "../../../ui/Choice.tsx"
import { Fieldset } from "../../../ui/Field.tsx"
import { Tooltip } from "../../../ui/Tooltip.tsx"
import type { ChatSession } from "../session.ts"

/** Writes to a server ("mcp") make this stale, so a changed allow list or switch shows here. */
const storyServersAtom = AppClient.query("ListStoryMcpServers", undefined, { reactivityKeys: ["mcp"] })

const ABOUT =
  "Tools from your MCP servers. A server's changes aren't undone by a swipe or a branch. A choice here applies from the next reply, on this branch."

function Row({ children, reset }: { children: ReactNode; reset: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2">
      <div className="min-w-0">{children}</div>
      {reset}
    </div>
  )
}

const settingsLink = (
  <Tooltip label="Opens Settings → MCP servers, where you add servers and choose their tools.">
    <Link to="/settings/mcp" className="text-accent underline-offset-4 hover:underline">
      Settings → MCP servers
    </Link>
  </Tooltip>
)

export function McpServersFieldset({
  session,
  choices
}: {
  session: ChatSession
  /** The branch's own choices (`agent.mcp`), by connection id. */
  choices: Readonly<Record<string, boolean>>
}) {
  const result = useAtomValue(storyServersAtom)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (!AsyncResult.isSuccess(result))
    return AsyncResult.isFailure(result) ? (
      <p role="alert" className="text-sm text-danger">
        Your MCP servers couldn't be read.
      </p>
    ) : null
  const servers = result.value
  const write = async (server: StoryMcpServer, on: boolean | null) => {
    setPending(server.connectionId)
    const outcome = await session.changeCast({ _tag: "McpConnection", connection: server.connectionId, on })
    setPending(null)
    setError(outcome.ok ? null : `That wasn't changed: ${outcome.error.message}`)
  }
  const busy = pending !== null
  return (
    <Fieldset legend="From MCP servers" about={ABOUT}>
      <div data-mcp-servers className="flex flex-col gap-2">
        {servers.length === 0 ? (
          <p className="text-sm text-muted">No MCP servers. Add one in {settingsLink}.</p>
        ) : (
          servers.map((server) => {
            const chosen = choices[server.connectionId]
            const on = chosen ?? server.stories
            const none = server.allowedTools === 0
            return (
              <Row
                key={server.connectionId}
                reset={
                  chosen === undefined ? null : (
                    <Button
                      variant="ghost"
                      className="-my-1 h-6! shrink-0 px-1.5 text-xs"
                      disabled={busy}
                      hint={`Goes back to your account setting: ${server.stories ? "on" : "off"}.`}
                      onClick={() => void write(server, null)}
                    >
                      Reset
                    </Button>
                  )
                }
              >
                <Checkbox
                  checked={on && !none}
                  disabled={busy || none}
                  hintInline={false}
                  hint={
                    none
                      ? "None of its tools are allowed. Choose them in Settings → MCP servers."
                      : on
                        ? `Click to stop replies on this branch using ${server.name}'s tools.`
                        : `Click to let replies on this branch use ${server.name}'s tools. Each call sends what the model writes in it to ${server.host}.`
                  }
                  description={
                    none
                      ? "None of its tools are allowed."
                      : `${server.allowedTools} ${server.allowedTools === 1 ? "tool" : "tools"}`
                  }
                  onCheckedChange={(next) => void write(server, next)}
                >
                  {server.name}
                </Checkbox>
              </Row>
            )
          })
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </Fieldset>
  )
}
