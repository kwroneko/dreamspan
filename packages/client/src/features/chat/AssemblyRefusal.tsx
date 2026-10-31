// Why the next reply can't be prepared, above the composer and aligned with it. A budget refusal
// names each number's source and opens the model's settings at the context size.
import type { NextContext } from "@rp/shared/inspectorApi.ts"
import { Alert } from "../../ui/Surface.tsx"
import { ChangeContextSize, contextOrigin, reserveOrigin, withOrigin } from "./budgetSources.tsx"

export function AssemblyRefusal({ history }: { history: Omit<NextContext, "warmth"> }) {
  const budget = history.assemblyErrorReason === "budget" ? history.budget : null
  return (
    <div className="mx-auto w-full max-w-3xl pb-2">
      <Alert
        tone="danger"
        title="Can't prepare the next reply"
        actions={budget ? <ChangeContextSize origins={budget.origins} /> : undefined}
      >
        <p>{history.assemblyError}</p>
        {budget && (
          <p className="mt-1 text-muted">
            The card, prompts and other fixed content take ~{budget.nonHistoryTokens.toLocaleString()} tokens and the
            reply reserves {withOrigin(budget.responseReserve, reserveOrigin(budget.origins))}, more than the context
            size of {withOrigin(budget.maximum, contextOrigin(budget.origins), " tokens")}.
          </p>
        )}
      </Alert>
    </div>
  )
}
