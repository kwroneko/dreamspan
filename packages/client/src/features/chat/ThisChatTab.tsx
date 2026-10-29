import { useUserDraft, UserDraftStatus } from "../editor/userDraft.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { chatSettingSections, summarySettingFields } from "./presentation.tsx"
// The side panel's "This chat" tab (DESIGN §5.4, §8; DATA-MODEL §5.3, §5.4): what the
// next reply is sent with, each with its value and where it comes from, and the chat's own
// settings. A change is a state event at the leaf shown, so from there on, on this branch.
// The context assembler reads them; this only writes them.
import type { CastChange } from "@rp/shared/chatSetupApi.ts"
import { Link } from "@tanstack/react-router"
import { BUILTIN_SUMMARY_INSTRUCTION, type LcmSettingsChange, resolveLcm } from "@rp/shared/lcmSettings.ts"
import type { LcmSettingsView } from "@rp/shared/lcm.ts"
import { useEffect, useState, useSyncExternalStore } from "react"
import { useAction } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import { RadioGroup, Switch } from "../../ui/Choice.tsx"
import { CodeEditor } from "../../ui/CodeEditor.tsx"
import { Fieldset } from "../../ui/Field.tsx"
import { Loading } from "../../ui/Spinner.tsx"
import { useCast } from "./cast.ts"
import { EnableLcmDialog } from "./EnableLcmDialog.tsx"
import { type Write } from "./LcmFields.tsx"
import type { ChatSession } from "./session.ts"

const link = "text-accent hover:underline"

function Problem({ error }: { error: AppError | null }) {
  return error ? (
    <p role="alert" className="text-sm text-danger">
      {error.message}
    </p>
  ) : null
}

/** The instruction in the code editor, saved by its button; "Use account default" drops the chat's own. */
function Instruction({
  view,
  write,
  disabled,
  targetId
}: {
  view: LcmSettingsView
  write: Write
  disabled: boolean
  targetId: string
}) {
  const saved = view.resolved.tail ?? BUILTIN_SUMMARY_INSTRUCTION
  const draft = useUserDraft(targetId, "Summarization instruction", saved)
  const { text, setText } = draft
  const base = saved
  const [problem, setProblem] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const own = view.resolved.from.tail === "chat"
  const save = async (change: LcmSettingsChange) => {
    setPending(true)
    const message = await write(change)
    setPending(false)
    setProblem(message)
    return message === null
  }
  return (
    <Fieldset
      legend="Instruction"
      description="What the summary request asks for. {{words}} is the summary length (under Advanced)."
    >
      <CodeEditor label="This chat's summarization instruction" value={text} base={base} rows={5} onChange={setText} />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={disabled || text === saved || text.trim() === ""}
          pending={pending}
          onClick={() =>
            void draft.commit(text, async () => {
              setPending(true)
              const message = await write({ tail: text })
              setPending(false)
              setProblem(message)
              return message === null
            })
          }
        >
          Save instruction
        </Button>
        {own && (
          <Button
            variant="ghost"
            disabled={disabled || pending}
            onClick={() => void draft.discard(() => save({ tail: null }))}
          >
            Use account default
          </Button>
        )}
        <span className="text-xs text-muted">
          {own
            ? "This chat's own."
            : view.resolved.from.tail === "account"
              ? "The account default."
              : "The built-in instruction."}
          {text !== saved && " Not saved yet."}
        </span>
      </div>
      <UserDraftStatus draft={draft} />
      {problem && <p className="text-sm text-danger">{problem}</p>}
    </Fieldset>
  )
}

/**
 * Summarization for the whole chat (DESIGN §8): on for new chats, off for imported ones, and its
 * settings, each the chat's own or the account default's. Turning it on for a chat with messages
 * asks how to start and what it costs first (spec/LCM.md §2.7, §2.11).
 */
export function SummariesSetting({ session }: { session: ChatSession }) {
  const view = useSyncExternalStore(session.subscribe, session.snapshot)
  const [error, setError] = useState<AppError | null>(null)
  const [enabling, setEnabling] = useState(false)
  const [settings, setSettings] = useState<LcmSettingsView | null>(null)
  const [reads, setReads] = useState(0)
  useEffect(() => {
    let live = true
    void session
      .call((client) =>
        client("GetLcmSettings", { chatId: session.id, forkId: view.forkId, leafSlotId: view.leafSlotId })
      )
      .then((result) => {
        if (!live) return
        if (result.ok) setSettings(result.value)
        else setError(result.error)
      })
    return () => {
      live = false
    }
  }, [session, view.forkId, view.leafSlotId, view.lcmVersion, view.history, reads])
  const enabled = settings?.resolved.enabled ?? view.lcm?.enabled ?? false
  const write: Write = async (change) => {
    const result = await session.call((client) =>
      client("ChangeLcmSettings", { chatId: session.id, forkId: view.forkId, change })
    )
    setReads((n) => n + 1)
    if (result.ok) return null
    return result.error.message
  }
  return (
    <section aria-label="Summaries" className="flex flex-col gap-4">
      <h3 className="text-xs font-medium tracking-wide text-muted uppercase">Summaries</h3>
      <Switch
        checked={enabled}
        onCheckedChange={(on) => {
          if (on && view.leafSlotId !== null) return setEnabling(true)
          void session
            .call((client) =>
              client("ChangeLcmSettings", { chatId: session.id, forkId: view.forkId, change: { enabled: on } })
            )
            .then((result) => {
              setError(result.ok ? null : result.error)
              setReads((n) => n + 1)
            })
        }}
        description="Older messages are summarized so the chat can go on. For the whole chat, not from here on. Nothing is generated until your next reply."
      >
        Summarize older messages
      </Switch>
      {enabling && (
        <EnableLcmDialog
          session={session}
          onOpenChange={(open) => {
            setEnabling(open)
            if (!open) setReads((n) => n + 1)
          }}
        />
      )}
      {settings === null ? (
        <Loading />
      ) : (
        <SlotOutlet
          slot={summarySettingFields}
          props={{
            scope: "chat",
            view: settings,
            fallback: resolveLcm(null, settings.account),
            write,
            disabled: false,
            instruction: (
              <Instruction
                key={view.forkId}
                targetId={`chat:${session.id}:fork:${view.forkId}`}
                view={settings}
                write={write}
                disabled={false}
              />
            )
          }}
        />
      )}
      <Problem error={error} />
    </section>
  )
}

export function RolesSetting({ session }: { session: ChatSession }) {
  const { cast } = useCast()
  const rolesProjection = cast?.rolesProjection ?? "by_writer"
  const roleOptions = cast?.roleProjections ?? []
  const unknownRoles = cast && !roleOptions.some((option) => option.id === rolesProjection) ? rolesProjection : null
  const action = useAction()
  const [error, setError] = useState<AppError | null>(null)
  const change = async (next: CastChange) => {
    const outcome = await session.changeCast(next)
    setError(outcome.ok ? null : outcome.error)
  }
  return (
    <>
      <section aria-label="Roles" className="flex flex-col gap-2">
        <h3 id="roles-label" className="text-xs font-medium tracking-wide text-muted uppercase">
          Roles
        </h3>
        <p className="text-sm text-muted">Which messages are sent as the user's and which as the model's.</p>
        <RadioGroup
          aria-labelledby="roles-label"
          value={rolesProjection}
          onValueChange={(projection) => void change({ _tag: "Roles", projection })}
          options={[
            ...(unknownRoles
              ? [
                  {
                    value: unknownRoles,
                    label: `${unknownRoles} (not installed)`,
                    description: "Sent by writer until it is back."
                  }
                ]
              : []),
            ...roleOptions.map(({ id, label, description }) => ({ value: id, label, description }))
          ]}
        />
      </section>
      <p className="text-sm text-muted">
        The refusal judge, the fallback summarizer and the summarization defaults for new chats apply to all your chats:
        they're in{" "}
        <Link to="/settings/chats" className={link}>
          Settings → Chats
        </Link>
        .
      </p>
      <Problem error={error ?? action.error} />
    </>
  )
}

export function ThisChatTab({ session }: { session: ChatSession; active: boolean }) {
  return (
    <div className="flex flex-col gap-6">
      <SlotOutlet slot={chatSettingSections} props={{ session }} />
    </div>
  )
}
