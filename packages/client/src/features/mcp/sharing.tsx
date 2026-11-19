// Sharing an admin's MCP server (spec/MCP.md §3, §13.1 "Sharing"): the server page's Sharing card
// and its dialog with a user picker. Others use its tools with their own switches, allow list,
// sign-in and session; they never see its address, keys or program.
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { McpShareScope } from "@dreamspan/shared/mcp.ts"
import { useState } from "react"
import { AsyncView, ErrorAlert, useAction } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { useSession } from "../../session.ts"
import { Button } from "../../ui/Button.tsx"
import { Checkbox, RadioGroup } from "../../ui/Choice.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Card, CardHeader } from "../../ui/Surface.tsx"
import type { McpSectionProps } from "./detail.tsx"

const usersAtom = AppClient.query("ListUsers", undefined, { reactivityKeys: ["users"] })

const scopeOptions = [
  { value: "private" as const, label: "Only me", description: "Nobody else sees it." },
  {
    value: "all" as const,
    label: "Everyone",
    description: "Every account on this server, including ones made later."
  },
  { value: "chosen" as const, label: "Chosen people", description: "Only the people you pick." }
]

function ShareDialog({ connection, onOpenChange }: McpSectionProps & { onOpenChange: (open: boolean) => void }) {
  const action = useAction()
  const session = useSession()
  const [scope, setScope] = useState<McpShareScope>(connection.share.scope)
  const [chosen, setChosen] = useState<ReadonlySet<UserId>>(new Set(connection.share.userIds))
  const save = async () => {
    const result = await action.run(
      (client) =>
        client("SetMcpShare", {
          connectionId: connection.id,
          scope,
          userIds: scope === "chosen" ? [...chosen] : []
        }),
      ["mcp", "workshop-capabilities"]
    )
    if (result.ok) onOpenChange(false)
  }
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={`Share “${connection.name}”`}
      description="Others can use its tools but never see its address, keys or program. Each person turns it on for themselves and signs in with their own account."
    >
      <div className="flex flex-col gap-4" data-mcp-share-dialog>
        <RadioGroup<McpShareScope>
          aria-label="Who can use it"
          value={scope}
          onValueChange={setScope}
          options={scopeOptions}
        />
        {scope === "chosen" && (
          <AsyncView atom={usersAtom} loading="Loading people…">
            {(users) => {
              const others = users.filter((user) => user.id !== session.user.id && !user.disabled)
              return others.length === 0 ? (
                <p className="text-sm text-muted">There’s nobody else on this server yet.</p>
              ) : (
                <ul className="flex max-h-72 flex-col gap-2 overflow-y-auto p-2" aria-label="People">
                  {others.map((user) => (
                    <li key={user.id}>
                      <Checkbox
                        checked={chosen.has(user.id)}
                        onCheckedChange={(on) => {
                          const next = new Set(chosen)
                          if (on) next.add(user.id)
                          else next.delete(user.id)
                          setChosen(next)
                        }}
                        description={user.displayName === user.handle ? undefined : user.handle}
                        hint={
                          chosen.has(user.id)
                            ? `Click to stop sharing it with ${user.displayName || user.handle}.`
                            : `Click to share it with ${user.displayName || user.handle}.`
                        }
                      >
                        {user.displayName || user.handle}
                      </Checkbox>
                    </li>
                  ))}
                </ul>
              )
            }}
          </AsyncView>
        )}
        {scope !== connection.share.scope && connection.share.scope !== "private" && scope === "private" && (
          <p className="text-sm text-muted">
            The people it’s shared with lose it, with their sign-in and choices. Their chats can’t use it any more.
          </p>
        )}
        <ErrorAlert error={action.error} title="Not shared" />
        <DialogActions>
          <Button hint="Closes this dialog without changing who can use it." onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            hint="Saves who can use this server."
            variant="primary"
            pending={action.pending}
            disabled={scope === "chosen" && chosen.size === 0}
            focusableWhenDisabled
            onClick={() => void save()}
          >
            Save
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  )
}

/** Who can use it, in a few words. */
const shareSummary = (scope: McpShareScope, count: number) =>
  scope === "private"
    ? "Only you."
    : scope === "all"
      ? "Everyone on this server."
      : `${count} ${count === 1 ? "person" : "people"} you chose.`

/** Shown to the admin who owns the server. */
export function SharingSection(props: McpSectionProps) {
  const { connection } = props
  const session = useSession()
  const [open, setOpen] = useState(false)
  if (!connection.owned || session.user.role !== "admin") return null
  return (
    <Card>
      <CardHeader
        title="Sharing"
        about="Others can use its tools but never see its address, keys or program."
        description={shareSummary(connection.share.scope, connection.share.userIds.length)}
        actions={
          <Button hint="Chooses who else can use this server's tools." onClick={() => setOpen(true)}>
            Change
          </Button>
        }
      />
      {open && <ShareDialog {...props} onOpenChange={setOpen} />}
    </Card>
  )
}
