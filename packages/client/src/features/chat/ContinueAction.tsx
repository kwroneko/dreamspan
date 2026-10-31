// Continue (ST's, DESIGN §7.5): on the latest message, when the version shown is finished with
// text (stopped, interrupted, cut off or complete), whoever wrote it (an edit of a reply is
// the user's), a new generated version that starts as its text and streams on from its end.
// The old version stays. It needs a model
// that takes the start of its reply (a prefill); with another, the button says why it isn't
// available, and a click (or a tap, where there's no tooltip) shows the reason in full. A
// model that's only not set up for one gets a way to set it up here, or to try it once.
import { RegistryContext } from "@effect/atom-react"
import type { ConnectionId } from "@rp/shared/providers.ts"
import { originalReply } from "@rp/shared/replySections.ts"
import { Context, Effect } from "effect"
import { AtomRegistry, Reactivity } from "effect/reactivity"
import { useContext, useState, useSyncExternalStore } from "react"
import { describeCause } from "../../errors.ts"
import { AppClient } from "../../rpc.ts"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { IconButton, iconButtonClass } from "../../ui/Tooltip.tsx"
import type { ChatSession } from "./session.ts"

import { invokeMessageAction, type MessageActionContext, type MessageActionProps } from "./messageActions.tsx"

type NextModel = NonNullable<ReturnType<ChatSession["snapshot"]>["history"]>["model"]

/** Why Continue can't be used with the next request's model; null when it can. */
const continueBlocked = (model: NextModel): string | null => {
  if (model === undefined) return "Continue is waiting for the next model’s prefill capability."
  if (model === null) return "Continue needs a model: none is chosen for this chat. Choose one in This chat."
  const name = model.modelKey ?? "this model"
  const where = model.connectionName ? ` (${model.connectionName})` : ""
  if (model.prefill === undefined)
    return "Continue is unavailable while the next model’s prefill capability is unresolved."
  if (model.prefill === "none")
    return `Continue isn't available with ${name}${where} yet: it isn't set up to take the start of its reply (a prefill). Open Continue on the reply to turn that on, or to try it once.`
  if (model.continueUnavailable) return `Continue isn't available with ${name}${where}: ${model.continueUnavailable}`
  if (model.prefill === "assistant" || model.prefill === "tool_schema") return null
  return `Continue isn't available with ${name}${where}: it isn't set up to take the start of its reply (a prefill). If it can, turn on its Prefill capability in Settings → Connections.`
}

/** The latest finished version with text can continue, whoever wrote it. */
export const canContinue = ({ entry, session }: MessageActionContext) => {
  if (
    entry.version.status === "generating" ||
    originalReply(entry.version.content, entry.version.replySections).trim() === ""
  )
    return false
  const view = session.snapshot()
  return !view.loading && view.newer === null && view.entries.at(-1)?.slotId === entry.slotId
}

export const runContinue = async (context: MessageActionContext, source: "button" | "keyboard") => {
  const blocked = continueBlocked(context.session.snapshot().history?.model)
  if (blocked !== null) {
    context.report({ ok: false, error: { tag: "ContinueUnavailable", message: blocked, problems: [], reason: null } })
    return
  }
  context.report(await context.session.continueVersion(context.entry, source !== "keyboard"))
}

/**
 * Saves that the model takes a prefill (an assistant message at the end, ST's), as the
 * model's form in Settings → Connections does, and has the lists showing models read again.
 */
const enablePrefill = (registry: AtomRegistry.AtomRegistry, connection: string, model: string) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const services = yield* AtomRegistry.getResult(registry, AppClient.runtime)
      const client = Context.get(services, AppClient)
      const models = yield* client("ListModels", { connectionId: connection as ConnectionId, includeHidden: true })
      const row = models.find((candidate) => candidate.id === model)
      if (row === undefined) return false
      yield* client("EditModel", {
        modelId: row.id,
        overrides: { ...row.overrides, prefill: "assistant" },
        expectedRowVersion: row.rowVersion
      })
      Context.get(
        services as unknown as Context.Context<Reactivity.Reactivity>,
        Reactivity.Reactivity
      ).invalidateUnsafe(["models"])
      return true
    })
  )

/** Continue with a model not set up for a prefill: why, and the two ways on from here. */
function ContinueSetup({
  context,
  model
}: {
  context: MessageActionProps
  model: NonNullable<NextModel> & { readonly prefill: "none" }
}) {
  const registry = useContext(RegistryContext)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = model.modelKey ?? "This model"
  const where = model.connectionName ? ` (${model.connectionName})` : ""
  const enable = async () => {
    setBusy(true)
    setError(null)
    const exit = await enablePrefill(registry, model.connection, model.model)
    if (exit._tag === "Failure") setError(describeCause(exit.cause).message)
    else if (!exit.value) setError(`${name} isn't in its connection's list any more. Choose the model again.`)
    else {
      await context.session.readNextContext()
      setOpen(false)
      void invokeMessageAction("message.continue", context, "button")
    }
    setBusy(false)
  }
  const tryOnce = async () => {
    setOpen(false)
    context.report(await context.session.continueVersion(context.entry, true, true))
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setError(null)
      }}
      triggerLabel="Continue: set up first"
      hint={`Continue: ${name} isn't set up for it yet. Click for options.`}
      trigger={<Icon name="continue" />}
      triggerClassName={`${iconButtonClass()} opacity-60`}
      title="Continue this reply"
      side="bottom"
      align="end"
    >
      <p className="text-sm">
        Continue sends this reply as the start of the model’s answer (a prefill), so it writes on from the end. {name}
        {where} isn’t set up to take one.
      </p>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm">This model supports prefill</span>
        <Button variant="primary" disabled={busy} onClick={() => void enable()}>
          Enable
        </Button>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-muted">Not sure?</span>
        <Button disabled={busy} onClick={() => void tryOnce()}>
          Try it once
        </Button>
      </div>
      <p className="text-xs text-muted">
        Enable remembers it for {name} in every chat (Settings → Connections), then continues. Try it once changes
        nothing. A model that can’t take a prefill may start a new reply instead of continuing.
      </p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </Popover>
  )
}

export function ContinueAction(context: MessageActionProps) {
  const { session } = context
  const model = useSyncExternalStore(session.subscribe, () => session.snapshot().history?.model)
  if (model?.prefill === "none") return <ContinueSetup context={context} model={{ ...model, prefill: "none" }} />
  const blocked = continueBlocked(model)
  return (
    <IconButton
      label={blocked ?? "Continue: write on from the end of this reply (Alt+Enter; keeps composer text)"}
      icon="continue"
      className={blocked === null ? undefined : "opacity-50"}
      onClick={() => void invokeMessageAction("message.continue", context, "button")}
    />
  )
}
