import { useUserDraft, UserDraftStatus } from "../editor/userDraft.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { chatSettingSections, summarySettingFields } from "./presentation.tsx"
// The side panel's "This chat" tab (DESIGN §5.4, §8; DATA-MODEL §5.3, §5.4): first what a
// person touches (the chat's name, who they play, summaries on or off), then what few need,
// collapsed. Each section is registered (`chatSettingSections`), so a plugin can add or replace one.
// A change is a state event at the leaf shown, so from there on, on this branch.
// The context assembler reads them; this only writes them.
import type { CastChange } from "@rp/shared/chatSetupApi.ts"
import { Link } from "@tanstack/react-router"
import { BUILTIN_SUMMARY_INSTRUCTION, type LcmSettingsChange, resolveLcm } from "@rp/shared/lcmSettings.ts"
import type { LcmSettingsView } from "@rp/shared/lcm.ts"
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react"
import { useAction } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import { RadioGroup, Switch } from "../../ui/Choice.tsx"
import { CodeEditor } from "../../ui/CodeEditor.tsx"
import { Avatar } from "../../ui/Avatar.tsx"
import { Fieldset } from "../../ui/Field.tsx"
import { Disclosure } from "../../ui/Surface.tsx"
import { Loading } from "../../ui/Spinner.tsx"
import { useCast } from "./cast.ts"
import { chatDisplayName } from "./chatTitle.ts"
import { EnableLcmDialog } from "./EnableLcmDialog.tsx"
import { type Write } from "./LcmFields.tsx"
import { useShowPanel } from "./panels.tsx"
import { PersonaSwitch } from "./PersonaSwitch.tsx"
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

/** This chat's summary settings, read again after each change and at each leaf shown. */
function useLcmSettings(session: ChatSession) {
  const view = useSyncExternalStore(session.subscribe, session.snapshot)
  const [error, setError] = useState<AppError | null>(null)
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
  const reread = () => setReads((n) => n + 1)
  const write: Write = async (change) => {
    const result = await session.call((client) =>
      client("ChangeLcmSettings", { chatId: session.id, forkId: view.forkId, change })
    )
    reread()
    if (result.ok) return null
    return result.error.message
  }
  return { view, settings, error, setError, reread, write }
}

/** Opens another of the panel's tabs, as a link would. */
function PanelLink({ panel, children }: { panel: string; children: ReactNode }) {
  const show = useShowPanel()
  return (
    <button
      type="button"
      className={`${link} outline-none focus-visible:ring-2 focus-visible:ring-focus`}
      onClick={() => show(panel)}
    >
      {children}
    </button>
  )
}

/**
 * The chat's name, and who you play in it (`{{user}}`): what a chat is, before how it's sent.
 * Renaming stays with the name at the top of the chat, which also asks about the chat's group.
 */
export function ChatIdentity({ session }: { session: ChatSession }) {
  const view = useSyncExternalStore(session.subscribe, session.snapshot)
  const cast = view.cast
  const personaId = cast?.playedByMe[0] ?? null
  const persona = personaId === null ? undefined : cast?.cards.find((card) => card.entityId === personaId)
  return (
    <section aria-label="This chat" className="flex flex-col gap-4">
      <h2
        title={chatDisplayName(view)}
        className="line-clamp-2 text-lg leading-snug font-semibold [overflow-wrap:anywhere]"
      >
        {chatDisplayName(view)}
      </h2>
      <div role="group" aria-label="Your persona" className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {persona && (
          <Avatar
            id={persona.entityId}
            name={persona.name}
            mediaId={persona.avatarMediaId}
            crop={persona.avatarCrop}
            size="lg"
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-xs text-muted">You play</span>
          <span className="font-medium [overflow-wrap:anywhere]">{persona?.name ?? (cast ? "No persona" : "…")}</span>
        </div>
        <PersonaSwitch session={session} trigger="Switch persona" />
      </div>
    </section>
  )
}

/**
 * Summaries on or off for the whole chat (DESIGN §8): on for new chats, off for imported ones.
 * Turning them on for a chat with messages asks how to start and what it costs first
 * (spec/LCM.md §2.7, §2.11). Their settings are with the summaries, in the Summaries tab.
 */
export function SummariesSwitch({ session }: { session: ChatSession }) {
  const { view, settings, error, setError, reread } = useLcmSettings(session)
  const [enabling, setEnabling] = useState(false)
  const enabled = settings?.resolved.enabled ?? view.lcm?.enabled ?? false
  return (
    <section aria-label="Summaries" className="flex flex-col gap-2">
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
              reread()
            })
        }}
        description={
          <>
            Older messages are summarized so the chat can go on past what the model takes. Nothing is generated until
            your next reply. The summaries and how they're written: <PanelLink panel="summaries">Summaries</PanelLink>.
          </>
        }
      >
        Summarize older messages
      </Switch>
      {enabling && (
        <EnableLcmDialog
          session={session}
          onOpenChange={(open) => {
            setEnabling(open)
            if (!open) reread()
          }}
        />
      )}
      <Problem error={error} />
    </section>
  )
}

/** How this chat's summaries are written and sent, each the chat's own or the account default's. */
export function SummarySettings({ session }: { session: ChatSession }) {
  const { view, settings, error, write } = useLcmSettings(session)
  return (
    <Disclosure title="Summary settings">
      <section aria-label="Summary settings" className="flex flex-col gap-4">
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
    </Disclosure>
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
    <Disclosure title="Advanced: who each message is sent as">
      <section aria-label="Roles" className="flex flex-col gap-2">
        <p id="roles-label" className="text-sm text-muted">
          Which messages the model is sent as yours (the user's) and which as its own.
        </p>
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
      <Problem error={error ?? action.error} />
    </Disclosure>
  )
}

/** Where the settings for every chat are. */
export function AccountSettingsNote() {
  return (
    <p className="text-sm text-muted">
      The refusal judge, the fallback summarizer and the summary defaults for new chats apply to all your chats:{" "}
      <Link to="/settings/chats" className={link}>
        Settings → Chats
      </Link>
      .
    </p>
  )
}

export function ThisChatTab({ session }: { session: ChatSession; active: boolean }) {
  return (
    <div className="flex flex-col gap-6">
      <SlotOutlet slot={chatSettingSections} props={{ session }} />
    </div>
  )
}
