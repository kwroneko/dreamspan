// A context-length error that states the model's limit: one click saves it as the model's
// learned context size (its own source, shown as learned; never applied without the user).
import type { Version } from "@dreamspan/shared/chat.ts"
import type { ModelId } from "@dreamspan/shared/providers.ts"
import { useState } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"

export function LearnContextLimit({ version }: { version: Version }) {
  const action = useAction()
  const [saved, setSaved] = useState(false)
  const limit = version.error?.contextLimit
  if (!limit) return null
  return (
    <div className="mt-2 flex flex-col gap-2 text-text">
      {saved ? (
        <p role="status">
          Saved: the model&rsquo;s context size is {limit.tokens.toLocaleString()} tokens. › on the reply generates
          another swipe to try again.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span>The provider says this model takes {limit.tokens.toLocaleString()} tokens.</span>
          <Button
            pending={action.pending}
            hint="Use this as the model's context size, in every chat with it."
            onClick={async () => {
              const result = await action.run(
                (client) => client("SaveLearnedContext", { modelId: limit.modelId as ModelId, context: limit.tokens }),
                ["models"]
              )
              if (result.ok) setSaved(true)
            }}
          >
            Save {limit.tokens.toLocaleString()} as its context size
          </Button>
        </div>
      )}
      <ErrorAlert error={action.error} title="Not saved" />
    </div>
  )
}

export function LearnOutputLimit({ version }: { version: Version }) {
  const action = useAction()
  const [saved, setSaved] = useState(false)
  const limit = version.error?.outputLimit
  if (!limit) return null
  return (
    <div className="mt-2 flex flex-col gap-2 text-text">
      {saved ? (
        <p role="status">
          Saved: the model&rsquo;s output limit is {limit.tokens.toLocaleString()} tokens. › on the reply generates
          another swipe to try again.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span>The provider says this model outputs at most {limit.tokens.toLocaleString()} tokens.</span>
          <Button
            pending={action.pending}
            hint="Use this as the model's output limit, in every chat with it."
            onClick={async () => {
              const result = await action.run(
                (client) => client("SaveLearnedOutput", { modelId: limit.modelId as ModelId, maxOutput: limit.tokens }),
                ["models"]
              )
              if (result.ok) setSaved(true)
            }}
          >
            Save {limit.tokens.toLocaleString()} as its output limit
          </Button>
        </div>
      )}
      <ErrorAlert error={action.error} title="Not saved" />
    </div>
  )
}
