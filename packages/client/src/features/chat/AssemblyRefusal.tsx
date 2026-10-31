// Why the next reply can't be prepared, above the composer and aligned with it. A budget refusal
// is a calm notice, not an error: it says what takes the room, where each number comes from,
// and opens the model's settings at the context size.
import type { NextContext } from "@rp/shared/inspectorApi.ts"
import { Alert } from "../../ui/Surface.tsx"
import { ChangeContextSize, contextOrigin, reserveOrigin, withOrigin } from "./budgetSources.tsx"

export function AssemblyRefusal({ history }: { history: Omit<NextContext, "warmth"> }) {
  const budget = history.assemblyErrorReason === "budget" ? history.budget : null
  if (!budget)
    return (
      <div className="mx-auto w-full max-w-3xl pb-2">
        <Alert tone="danger" title="Can't prepare the next reply">
          {history.assemblyError}
        </Alert>
      </div>
    )
  const context = withOrigin(budget.maximum, contextOrigin(budget.origins), " tokens")
  const fixed = `~${budget.nonHistoryTokens.toLocaleString()} tokens`
  const reserve = withOrigin(budget.responseReserve, reserveOrigin(budget.origins))
  // Only when the fixed part and the reply's reserve really exceed the size is that the reason;
  // otherwise the refusal's own message (the newest message, a summary chunk) says what doesn't fit.
  const fixedOverflows = budget.nonHistoryTokens + budget.responseReserve > budget.maximum
  return (
    <div className="mx-auto w-full max-w-3xl pb-2">
      <Alert
        tone="warning"
        title="The next reply doesn't fit the context size"
        actions={<ChangeContextSize origins={budget.origins} primary />}
      >
        {fixedOverflows ? (
          <p>
            The card, prompts and other fixed content take {fixed} and the reply reserves {reserve}: more than the
            context size of {context}.
          </p>
        ) : (
          <>
            <p>{history.assemblyError}</p>
            <p className="mt-1 text-muted">
              The context size is {context}; the card, prompts and other fixed content take {fixed} and the reply
              reserves {reserve}.
            </p>
          </>
        )}
      </Alert>
    </div>
  )
}
