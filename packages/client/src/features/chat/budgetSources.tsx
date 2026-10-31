// Where the context budget's numbers come from, in words, and the action that changes them:
// the model's settings, opened at the field (the budget note's and the refusal's).
import type { BudgetOrigins } from "@rp/shared/inspectorApi.ts"
import { lazy, Suspense, useState } from "react"
import { Button } from "../../ui/Button.tsx"
import type { ModelField } from "../connections/models.tsx"

// The settings form loads when it's opened, not with every chat.
const ModelSettingsDialog = lazy(() =>
  import("../connections/models.tsx").then((m) => ({ default: m.ModelSettingsDialog }))
)

/** The context size's source, as a parenthesis after the number. */
export const contextOrigin = (origins: BudgetOrigins | undefined) => {
  switch (origins?.context) {
    case undefined:
      return null
    case "setting":
      return "the model's context size setting"
    case "user":
      return "your setting for the model's window"
    case "learned":
      return "learned from the provider's error"
    case "upstream":
      return "as the provider reports it"
    case "catalog":
      return `from ${origins.catalog ?? "a catalog"}`
    case "assumed":
      return "assumed: nothing reports this model's size"
  }
}

export const reserveOrigin = (origins: BudgetOrigins | undefined) =>
  origins === undefined ? null : origins.reserve === "setting" ? "the model's response length" : "default"

export const targetOrigin = (origins: BudgetOrigins | undefined) =>
  origins === undefined ? null : origins.target === "setting" ? "the model's history target" : "default, 80%"

/** The field that changes the context size: the model's own setting when that's in use, else its window. */
const fieldOf = (origins: BudgetOrigins): ModelField =>
  origins.context === "setting" ? "openai_max_context" : "context"

/** Opens the model's settings at the context size; nothing without a model. */
export function ChangeContextSize({ origins }: { origins: BudgetOrigins | undefined }) {
  const [open, setOpen] = useState(false)
  const model = origins?.model
  if (!origins || !model) return null
  return (
    <>
      <Button variant={origins.context === "assumed" ? "primary" : "ghost"} onClick={() => setOpen(true)}>
        {origins.context === "assumed" ? "Set the context size" : "Change the context size"}
      </Button>
      {open && (
        <Suspense fallback={null}>
          <ModelSettingsDialog
            connectionId={model.connectionId}
            modelId={model.modelId}
            focus={fieldOf(origins)}
            onOpenChange={setOpen}
          />
        </Suspense>
      )}
    </>
  )
}

/** "8,192 (assumed: …)" */
export const withOrigin = (tokens: number, origin: string | null) =>
  `${tokens.toLocaleString()}${origin ? ` (${origin})` : ""}`
