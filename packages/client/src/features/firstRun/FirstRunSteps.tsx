// The home screen's getting-started steps: connect a model, import characters, start a chat.
// Each is ticked once done, and the steps stay until all three are, so a library imported
// before any model was connected still says what's missing.
import type { GenerationDefaults } from "@rp/shared/generation.ts"
import { type Model, resolveModel } from "@rp/shared/providers.ts"
import { useAtomValue } from "@effect/atom-react"
import { Link } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import type { ReactNode } from "react"
import { buttonClass } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import type { ShellLibrary } from "../characters/shellData.tsx"
import { connectionsAtom, generationDefaultsAtom, modelsAtom } from "../connections/data.ts"

interface Step {
  readonly title: string
  readonly done: boolean
  readonly detail: ReactNode
  readonly action?: { readonly to: string; readonly label: string } | undefined
}

function ModelName({ chosen }: { chosen: NonNullable<GenerationDefaults["model"]> }) {
  const models = useAtomValue(modelsAtom(chosen.connection, true))
  const model = AsyncResult.isSuccess(models)
    ? models.value.find((entry: Model) => entry.id === chosen.model)
    : undefined
  return model ? (
    <>
      Using{" "}
      <span className="text-text [overflow-wrap:anywhere]">
        {resolveModel(model.key, model.upstream, model.overrides).name.value}
      </span>{" "}
      for new chats.
    </>
  ) : (
    "A model is chosen for new chats."
  )
}

export function FirstRunSteps({ data }: { data: ShellLibrary }) {
  const defaults = useAtomValue(generationDefaultsAtom)
  const connections = useAtomValue(connectionsAtom)
  if (!AsyncResult.isSuccess(defaults) || !AsyncResult.isSuccess(connections)) return null
  const chosen = defaults.value.model
  const cards = data.cards.length
  const chatted = data.cards.some((c) => c.card.chats > 0)
  const steps: ReadonlyArray<Step> = [
    chosen
      ? { title: "Connect a model", done: true, detail: <ModelName chosen={chosen} /> }
      : connections.value.length === 0
        ? {
            title: "Connect a model",
            done: false,
            detail: "Add the API you use, or a local server. Its models are fetched at once.",
            action: { to: "/settings/connections/new", label: "Connect a model" }
          }
        : {
            title: "Choose a model",
            done: false,
            detail: "You have a connection; pick the model that writes replies.",
            action: { to: "/settings/chats", label: "Choose a model" }
          },
    cards > 0
      ? {
          title: "Import from SillyTavern",
          done: true,
          detail: `${cards.toLocaleString()} ${cards === 1 ? "character" : "characters"} in your library.`
        }
      : {
          title: "Import from SillyTavern",
          done: false,
          detail: "Bring in your characters, chats, presets and lorebooks, or card files one at a time.",
          action: { to: "/import/st", label: "Import" }
        },
    {
      title: "Start a chat",
      done: chatted,
      detail: chatted
        ? "You have chats; they're in the sidebar."
        : cards > 0
          ? "Click a character below to open its chat."
          : "Once you have a character, click it to start."
    }
  ]
  const done = steps.filter((step) => step.done).length
  if (done === steps.length) return null
  const next = steps.findIndex((step) => !step.done)
  return (
    <section aria-labelledby="first-run-title" className="rounded-lg border border-border bg-surface p-4 sm:p-5">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 id="first-run-title" className="text-base font-semibold">
          Get started
        </h2>
        <span className="text-sm text-muted">
          {done} of {steps.length} done
        </span>
      </div>
      <ol className="flex flex-col divide-y divide-border">
        {steps.map((step, index) => (
          <li
            key={step.title}
            className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex min-w-0 items-start gap-3">
              <span
                className={`mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                  step.done
                    ? "bg-success/15 text-success"
                    : index === next
                      ? "bg-accent text-accent-contrast"
                      : "border border-border text-muted"
                }`}
              >
                {step.done ? <Icon name="check" size={14} /> : index + 1}
              </span>
              <div className="flex min-w-0 flex-col gap-0.5">
                <p className={`text-sm font-medium ${step.done ? "text-muted" : "text-text"}`}>
                  {step.title}
                  {step.done && <span className="sr-only"> (done)</span>}
                </p>
                <p className="text-sm text-muted">{step.detail}</p>
              </div>
            </div>
            {step.action && (
              <Link
                to={step.action.to}
                className={`${buttonClass(index === next ? "primary" : "secondary")} self-start sm:self-center`}
              >
                {step.action.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  )
}
