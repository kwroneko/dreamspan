// A version's reasoning ("thinking", DESIGN §7.4), above its text: it streams live, open by
// default, and folds when the reply is done; one click opens it again. Folding or opening it
// while the reply is still being written becomes the user's choice for every reply after
// (`user_prefs`, so it follows them to other devices). It's never sent back to the model.
import { useAtomValue } from "@effect/atom-react"
import type { Version } from "@rp/shared/chat.ts"
import type { ReasoningDisplay } from "@rp/shared/chatApi.ts"
import { AsyncResult } from "effect/reactivity"
import { useId, useState } from "react"
import { useAction } from "../../actions.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Markdown } from "../../ui/Markdown.tsx"
import { AppClient } from "../../rpc.ts"
import { liveReasoning } from "./session.ts"

const prefsAtom = AppClient.query("GetDisplayPrefs", {}, { reactivityKeys: ["displayPrefs"] })

const words = (text: string) => {
  const count = text.trim() === "" ? 0 : text.trim().split(/\s+/).length
  return count === 1 ? "1 word" : `${count.toLocaleString()} words`
}

export function Reasoning({ version }: { version: Version }) {
  const live = useAtomValue(liveReasoning(version.id))
  const text = live ?? version.reasoning ?? ""
  if (text === "") return null
  return <ReasoningBlock text={text} streaming={version.status === "generating"} />
}

function ReasoningBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const id = useId()
  const prefs = useAtomValue(prefsAtom)
  const preferred: ReasoningDisplay = AsyncResult.isSuccess(prefs) ? prefs.value.reasoning : "expanded"
  // What the user chose for this block; until then, open while streaming (as they prefer),
  // folded once the reply is done.
  const [chosen, setChosen] = useState<{ open: boolean; streaming: boolean } | null>(null)
  const save = useAction()
  const open =
    chosen !== null && chosen.streaming === streaming ? chosen.open : streaming ? preferred === "expanded" : false

  const toggle = () => {
    setChosen({ open: !open, streaming })
    // During a run the choice sticks: later replies stream that way too (DESIGN §7.4).
    if (streaming) {
      const reasoning: ReasoningDisplay = open ? "collapsed" : "expanded"
      if (reasoning !== preferred)
        void save.run((client) => client("SetDisplayPrefs", { prefs: { reasoning } }), ["displayPrefs"])
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={toggle}
        className="-ml-1 flex w-fit max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-xs text-muted outline-none hover:bg-surface-raised hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
      >
        <Icon name={open ? "down" : "right"} size={14} />
        <Icon name="reasoning" size={14} />
        <span className="font-medium">{streaming ? "Reasoning…" : "Reasoning"}</span>
        <span aria-hidden="true">·</span>
        <span>{words(text)}</span>
      </button>
      {open && (
        <div id={id} role="region" aria-label="Reasoning" className="border-l-2 border-border pl-3 text-sm text-muted">
          <Markdown text={text} streaming={streaming} />
        </div>
      )}
      {save.error && (
        <p role="alert" className="text-xs text-danger">
          Your choice wasn’t saved: {save.error.message}
        </p>
      )}
    </div>
  )
}
