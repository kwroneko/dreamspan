import { RegexScript } from "@rp/shared/docs/regexScript.ts"
import { type GlobalRegex, MAX_GLOBAL_SCRIPTS } from "@rp/shared/regexScripts.ts"
import { Schema } from "effect"
import { useState } from "react"
import { AsyncView, ErrorAlert, useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { Alert, Card, CardHeader, EmptyState } from "../../ui/Surface.tsx"
import { newScript, ScriptItem } from "../editor/RegexScripts.tsx"
import { useUserDraft, UserDraftStatus } from "../editor/userDraft.tsx"
import { useTitle } from "../shell.tsx"
import { globalRegexAtom } from "./data.ts"

const decodeScripts = Schema.decodeUnknownExit(Schema.Array(RegexScript))

function GlobalRegexForm({ saved }: { saved: GlobalRegex }) {
  // A draft kept on the server, like other account settings, so a reload doesn't lose it.
  const durable = useUserDraft("global-regex", "Global regex scripts", JSON.stringify(saved))
  const values = JSON.parse(durable.text) as GlobalRegex
  const action = useAction()
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [message, setMessage] = useState<string | null>(null)
  const edit = (scripts: ReadonlyArray<RegexScript>) => {
    setMessage(null)
    durable.setText(JSON.stringify({ ...values, scripts }))
  }
  const change = (index: number, patch: Partial<RegexScript>) =>
    edit(values.scripts.map((script, i) => (i === index ? { ...script, ...patch } : script)))
  const move = (index: number, by: -1 | 1) => {
    const next = [...values.scripts]
    const [script] = next.splice(index, 1)
    next.splice(index + by, 0, script!)
    edit(next)
  }
  const toggle = (id: string, next: boolean) => {
    const ids = new Set(open)
    if (next) ids.add(id)
    else ids.delete(id)
    setOpen(ids)
  }
  const stale = action.error?.tag === "StaleWrite"

  const save = async () => {
    setMessage(null)
    if (decodeScripts(values.scripts)._tag === "Failure") {
      setMessage("Check the scripts: each needs an id, and depths must be whole numbers.")
      return
    }
    let revision = values.revision
    const ok = await durable.commit(
      durable.text,
      async () => {
        const result = await action.run(
          (client) => client("SetGlobalRegex", { scripts: values.scripts, expectedRevision: values.revision }),
          ["globalRegex"]
        )
        if (result.ok) revision = result.value.revision
        return result.ok
      },
      (text) => JSON.stringify({ ...JSON.parse(text), revision })
    )
    if (ok) setMessage("Saved. Your chats use these scripts from now on.")
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <p className="text-sm text-muted">
        Global scripts run in every chat, before the preset's and the character's. Unless it's set to change only what's
        shown or only the prompt sent, a script rewrites messages as they're saved; you can still see and restore a
        message's original text.
      </p>
      <UserDraftStatus draft={durable} />
      {values.revision !== saved.revision && (
        <Alert tone="warning" title="The global scripts changed in another tab or device">
          <p>
            Your changes are based on an earlier version. Saved now:{" "}
            {saved.scripts.map((script) => script.name || "Unnamed script").join(", ") || "no scripts"}.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              onClick={() => {
                action.clearError()
                durable.setText(JSON.stringify({ ...values, revision: saved.revision }))
              }}
            >
              Keep my changes over them
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                action.clearError()
                void durable.discard()
              }}
            >
              Use the saved scripts
            </Button>
          </div>
        </Alert>
      )}
      <fieldset disabled={!durable.ready || action.pending} className="flex min-w-0 flex-col gap-4">
        {values.scripts.length === 0 ? (
          <EmptyState title="No global scripts" />
        ) : (
          <ul aria-label="Global regex scripts" className="flex flex-col divide-y divide-border">
            {values.scripts.map((script, index) => {
              const name = script.name || "Unnamed script"
              return (
                <ScriptItem
                  key={script.id}
                  script={script}
                  name={name}
                  binding={{ kind: "local", script, change: (patch) => change(index, patch) }}
                  open={open.has(script.id)}
                  onOpenChange={(next) => toggle(script.id, next)}
                  actions={
                    <>
                      <Button variant="ghost" disabled={index === 0} onClick={() => move(index, -1)}>
                        Move up
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={index === values.scripts.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        Move down
                      </Button>
                      <Button variant="ghost" onClick={() => edit(values.scripts.filter((_, i) => i !== index))}>
                        Delete the script
                      </Button>
                    </>
                  }
                />
              )
            })}
          </ul>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={values.scripts.length >= MAX_GLOBAL_SCRIPTS}
            onClick={() => {
              const script = newScript()
              edit([...values.scripts, script])
              toggle(script.id, true)
            }}
          >
            Add a script
          </Button>
          <Button type="submit" variant="primary" pending={action.pending}>
            Save the scripts
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              void durable.discard()
              setMessage(null)
              action.clearError()
            }}
          >
            Discard changes
          </Button>
        </div>
      </fieldset>
      {stale ? (
        <Alert tone="danger" title="The scripts weren't saved">
          <p>They changed in another tab or device since you opened them. Choose which to keep above, then save.</p>
        </Alert>
      ) : (
        <ErrorAlert error={action.error} title="The scripts weren't saved" />
      )}
      {message && <Alert>{message}</Alert>}
    </form>
  )
}

export function GlobalRegexPage() {
  useTitle("Regex scripts")
  return (
    <Card>
      <CardHeader title="Global regex scripts" description="Your own find-and-replace rules for every chat." />
      <AsyncView atom={globalRegexAtom}>{(saved) => <GlobalRegexForm saved={saved} />}</AsyncView>
    </Card>
  )
}
