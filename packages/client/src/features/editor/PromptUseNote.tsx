// Whether a card's own prompt is used (DESIGN §5.0): in place of the Main Prompt or the
// post-history prompt of the preset chats use now, unless that prompt forbids it. Read on the
// server without assembling a context.
import type { CardPromptUse } from "@rp/shared/chatSetupApi.ts"
import { useEffect, useState } from "react"
import type { Caller } from "./caller.ts"
import { type EditorStore, useText } from "./store.ts"

export function PromptUseNote({
  store,
  call,
  field
}: {
  store: EditorStore
  call: Caller
  field: "system_prompt" | "post_history_instructions"
}) {
  const text = useText(store, [field])
  const [use, setUse] = useState<CardPromptUse | null>(null)
  useEffect(() => {
    let live = true
    void call((client) => client("GetCardPromptUse", undefined)).then(
      (result) => live && setUse(result.ok ? result.value : null)
    )
    return () => {
      live = false
    }
  }, [call])
  if (!use) return null
  const target = field === "system_prompt" ? use.main : use.jailbreak
  const prompt = `${use.preset}'s ${target.name}`
  const message = !text.trim()
    ? `Empty, so ${prompt} is sent as it is.`
    : target.state === "replaceable"
      ? `Used in place of ${prompt} when this character speaks. {{original}} in it is that prompt's text.`
      : target.state === "forbidden"
        ? `Not used: ${prompt} can't be replaced.`
        : target.state === "disabled"
          ? `Not used: ${prompt} is off.`
          : `Not used: ${use.preset} has no ${target.name}.`
  return (
    <p className="text-xs text-muted" data-prompt-use={target.state}>
      {message}
    </p>
  )
}
