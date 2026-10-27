// The side panel's "This chat" tab (DESIGN §5.2, §5.4, §8; DATA-MODEL §5.3, §5.4): what the
// next reply is sent with, each with its value and where it comes from, and the chat's own
// settings. A change is a state event at the leaf shown, so from there on, on this branch.
// The context assembler reads them; this only writes them.
import type { CastChange } from "@rp/shared/chatSetupApi.ts"
import { Link } from "@tanstack/react-router"
import { useState, useSyncExternalStore } from "react"
import { useAction } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { RadioGroup, Switch } from "../../ui/Choice.tsx"
import { useCast } from "./cast.ts"
import { EnableLcmDialog } from "./EnableLcmDialog.tsx"
import type { ChatSession } from "./session.ts"

const link = "text-accent hover:underline"

function Problem({ error }: { error: AppError | null }) {
  return error ? (
    <p role="alert" className="text-sm text-danger">
      {error.message}
    </p>
  ) : null
}

/**
 * LCM for the whole chat (DESIGN §8): on for new chats, off for imported ones. Turning it on
 * for a chat with messages asks how to start and what it costs first (spec/LCM.md §2.7, §2.11).
 */
function SummariesSetting({ session }: { session: ChatSession }) {
  const view = useSyncExternalStore(session.subscribe, session.snapshot)
  const [error, setError] = useState<AppError | null>(null)
  const [enabling, setEnabling] = useState(false)
  const enabled = view.lcm?.enabled ?? false
  return (
    <section aria-label="Summaries" className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wide text-muted uppercase">Summaries</h3>
      <Switch
        checked={enabled}
        onCheckedChange={(on) => {
          if (on && view.leafSlotId !== null) return setEnabling(true)
          void session
            .call((client) => client("SetLcmEnabled", { chatId: session.id, enabled: on }))
            .then((result) => setError(result.ok ? null : result.error))
        }}
        description="Older messages are summarized so the chat can go on. For the whole chat, not from here on. Nothing is generated until your next reply."
      >
        Summarize older messages
      </Switch>
      {enabling && <EnableLcmDialog session={session} onOpenChange={setEnabling} />}
      <Problem error={error} />
    </section>
  )
}

export function ThisChatTab({ session }: { session: ChatSession; active: boolean }) {
  const { cast } = useCast()
  const action = useAction()
  const [error, setError] = useState<AppError | null>(null)
  const change = async (next: CastChange) => {
    const outcome = await session.changeCast(next)
    setError(outcome.ok ? null : outcome.error)
  }
  const multi = (cast?.participants.length ?? 0) > 1
  return (
    <div className="flex flex-col gap-6">
      <SummariesSetting session={session} />
      <section aria-label="Card layout" className="flex flex-col gap-2">
        <h3 id="layout-label" className="text-xs font-medium tracking-wide text-muted uppercase">
          Card layout
        </h3>
        <p className="text-sm text-muted">
          Where the members' cards go in what's sent{multi ? "" : "; it matters once a chat has several characters"}.
        </p>
        <RadioGroup
          aria-labelledby="layout-label"
          value={cast?.layoutCards ?? "concat"}
          onValueChange={(layout) => void change({ _tag: "Layout", layout })}
          options={[
            {
              value: "concat",
              label: "All cards together",
              description: "Every character's card, each in its own labelled block where the preset puts the card."
            },
            {
              value: "swap_tail",
              label: "Speaker's card last",
              description: "Only the replying character's card, at the end of the context, as ST's card swap does."
            }
          ]}
        />
      </section>
      <section aria-label="Roles" className="flex flex-col gap-2">
        <h3 id="roles-label" className="text-xs font-medium tracking-wide text-muted uppercase">
          Roles
        </h3>
        <p className="text-sm text-muted">Which messages are sent as the user's and which as the model's.</p>
        <RadioGroup
          aria-labelledby="roles-label"
          value={cast?.rolesProjection ?? "by_writer"}
          onValueChange={(projection) => void change({ _tag: "Roles", projection })}
          options={[
            { value: "by_writer", label: "By writer", description: "Yours as user, the model's as assistant." },
            {
              value: "alternate",
              label: "Alternating",
              description: "Strictly alternating by position, for models that require it."
            },
            {
              value: "perspective",
              label: "By perspective",
              description: "The replying character's own turns as assistant, everyone else's as user."
            }
          ]}
        />
      </section>
      <p className="text-sm text-muted">
        The refusal judge, the fallback summarizer and the default summarization instruction apply to all your chats:
        they're in{" "}
        <Link to="/settings/chats" className={link}>
          Settings → Chats
        </Link>
        .
      </p>
      <Problem error={error ?? action.error} />
    </div>
  )
}
