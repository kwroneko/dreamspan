import { chatKinds } from "@dreamspan/shared/chatKinds.ts"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { PersonaBadge } from "../../ui/PersonaBadge.tsx"
import { useUserDraft, UserDraftNotices, UserDraftUndo } from "../editor/userDraft.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { chatSettingSections, summarySettingFields } from "./presentation.tsx"
// The side panel's "This chat" tab (DESIGN §5.4, §8; DATA-MODEL §5.3, §5.4): first what a
// person touches (the chat's name, who they play, summaries on or off), then what few need,
// collapsed. Each section is registered (`chatSettingSections`), so a plugin can add or replace one.
// A change is a state event at the leaf shown, so from there on, on this branch.
// The context assembler reads them; this only writes them.
import type { CastChange } from "@dreamspan/shared/chatSetupApi.ts"
import type { ForkId } from "@dreamspan/shared/chat.ts"
import { BUILTIN_SUMMARY_INSTRUCTION, resolveLcm } from "@dreamspan/shared/lcmSettings.ts"
import type { LcmSettingsView } from "@dreamspan/shared/lcm.ts"
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { useAction } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import { RadioGroup, Switch } from "../../ui/Choice.tsx"
import { CodeEditor } from "../../ui/CodeEditor.tsx"
import { type InstructionTabTarget, instructionTabHref } from "../editor/fieldTab.ts"
import { useFieldTabLink } from "../editor/openFieldTab.ts"
import { INSTRUCTION_FIELD, instructionTarget } from "./instructionDraft.ts"
import { Avatar } from "../../ui/Avatar.tsx"
import { Field, Fieldset } from "../../ui/Field.tsx"
import { Disclosure } from "../../ui/Surface.tsx"
import { useOpenPlace } from "../editor/durable.tsx"
import { Loading } from "../../ui/Spinner.tsx"
import { useCast } from "./cast.ts"
import { chatDisplayName } from "./chatTitle.ts"
import { EnableLcmDialog } from "./EnableLcmDialog.tsx"
import { type Write } from "./LcmFields.tsx"
import { useShowPanel } from "./panels.tsx"
import { PersonaSwitch } from "./PersonaSwitch.tsx"
import type { ChatSession } from "./session.ts"
import { kindTitle, summarizes, useChatKindLook } from "./kindLooks.ts"
import { useTitledAbove } from "../../ui/titledContainer.tsx"
import { KindBadge } from "./KindBadge.tsx"
import { ModelSelect } from "../pickers/ModelPicker.tsx"
import { modelValue, parseModelValue, useModelChoices } from "./modelChoices.ts"

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
  targetId,
  tab
}: {
  view: LcmSettingsView
  write: Write
  disabled: boolean
  targetId: string
  /** The instruction's own tab (textTabs.tsx), the same draft. */
  tab: InstructionTabTarget
}) {
  const resolved = view.resolved.tail ?? BUILTIN_SUMMARY_INSTRUCTION
  const draft = useUserDraft(targetId, INSTRUCTION_FIELD, resolved)
  const expandTab = useFieldTabLink(instructionTabHref(tab))
  const { text, setText, saved, setSaved } = draft
  useEffect(() => setSaved(resolved), [resolved, setSaved])
  const [problem, setProblem] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const own = view.resolved.from.tail === "chat"
  const save = async (tail: string | null) => {
    setPending(true)
    const message = await write({ tail })
    if (message === null) setSaved(tail ?? resolveLcm(null, view.account).tail ?? BUILTIN_SUMMARY_INSTRUCTION)
    setPending(false)
    setProblem(message)
    return message === null
  }
  return (
    <Fieldset legend="Instruction" about="{{words}} is the summary length, set under Advanced.">
      <CodeEditor
        label="This chat's summarization instruction"
        value={text}
        base={saved}
        rows={5}
        onChange={setText}
        tools={<UserDraftUndo draft={draft} place="strip" />}
        expandTab={expandTab}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          hint="Saves this chat’s summarization instruction."
          disabled={disabled || text === saved || text.trim() === ""}
          pending={pending}
          onClick={() => void draft.commit(text, () => save(text))}
        >
          Save instruction
        </Button>
        {own && (
          <Button
            variant="ghost"
            disabled={disabled || pending}
            hint="Go back to your default instruction."
            onClick={() => void draft.discard(() => save(null))}
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
      <UserDraftNotices draft={draft} />
      {problem && <p className="text-sm text-danger">{problem}</p>}
    </Fieldset>
  )
}

/** This chat's summary settings, read again after each change and at each leaf shown. */
function useLcmSettings(session: ChatSession) {
  const view = useSyncExternalStore(session.subscribe, session.snapshot)
  const [error, setError] = useState<AppError | null>(null)
  const [loaded, setLoaded] = useState<{ forkId: ForkId | null; settings: LcmSettingsView } | null>(null)
  const settings = loaded?.forkId === view.forkId ? loaded.settings : null
  const [reads, setReads] = useState(0)
  const writes = useRef(0)
  useEffect(() => {
    let live = true
    const afterWrites = writes.current
    void session
      .call((client) =>
        client("GetLcmSettings", { chatId: session.id, forkId: view.forkId, leafSlotId: view.leafSlotId })
      )
      .then((result) => {
        if (!live || afterWrites !== writes.current) return
        if (result.ok) setLoaded({ forkId: view.forkId, settings: result.value })
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
    if (result.ok) writes.current++
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
    <Tooltip label="Opens the related chat settings panel.">
      <button
        type="button"
        className={`${link} outline-none focus-visible:ring-2 focus-visible:ring-focus`}
        onClick={() => show(panel)}
      >
        {children}
      </button>
    </Tooltip>
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
  // The phone's sheet is titled with the chat's name already (kindTitle): not shown twice there.
  const named = useTitledAbove(kindTitle(chatDisplayName(view), view.chat?.kind))
  return (
    <section aria-label="This chat" className="flex flex-col gap-4">
      <h2
        title={chatDisplayName(view)}
        className={named ? "sr-only" : "line-clamp-2 text-lg leading-snug font-semibold [overflow-wrap:anywhere]"}
      >
        {chatDisplayName(view)} <KindBadge kind={view.chat?.kind} />
      </h2>
      <div
        role="group"
        aria-label="Your persona"
        className="flex max-w-controls flex-wrap items-center gap-x-3 gap-y-2"
      >
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
          {persona ? <PersonaBadge played /> : <span className="text-xs text-muted">You play</span>}
          <span className="font-medium [overflow-wrap:anywhere]">{persona?.name ?? (cast ? "No persona" : "…")}</span>
        </div>
        <PersonaSwitch session={session} trigger="Switch persona" place="this-chat" />
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
  // A kind whose summaries stay off (a workshop) has no switch to offer.
  if (!summarizes(view.chat)) return null
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
        about="Keep the story in context as the chat grows."
        description={<PanelLink panel="summaries">Summaries</PanelLink>}
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

/**
 * The model that writes this chat's summaries from here on (its "summarizer" binding), or the
 * account's choice, which is the chat's own model unless Settings → Chats names one.
 */
function SummaryModel({ session, account }: { session: ChatSession; account: LcmSettingsView["account"] }) {
  const { cast } = useCast()
  const own = cast?.summaryModel ?? null
  const fromAccount = account?.summarizer ?? null
  const models = useModelChoices(
    true,
    [own, fromAccount].flatMap((m) => (m ? [modelValue(m.connection, m.model)] : []))
  )
  const [error, setError] = useState<AppError | null>(null)
  const accountLabel = fromAccount
    ? (models.find((m) => m.value === modelValue(fromAccount.connection, fromAccount.model))?.label ??
      "Model unavailable")
    : null
  const choose = (model: ReturnType<typeof parseModelValue> | null) =>
    session.changeCast({ _tag: "SummaryModel", model }).then((outcome) => setError(outcome.ok ? null : outcome.error))
  const follow = accountLabel ? `Account default: ${accountLabel}` : "Same as the chat's model"
  return (
    <Field
      label="Summary model"
      about="Writes summaries from here on, on this branch. If unavailable, uses the account choice, then the chat's model."
      error={error?.message}
    >
      <ModelSelect
        ariaLabel="This chat's summary model"
        items={models}
        value={own ? modelValue(own.connection, own.model) : null}
        placeholder={follow}
        onValueChange={(value) => void choose(parseModelValue(value))}
        clear={{
          label: fromAccount ? "Use the account default" : "Use the chat's model",
          hint: "This chat stops choosing its own summary model from here on.",
          onClear: () => void choose(null)
        }}
      />
    </Field>
  )
}

/** How this chat's summaries are written and sent, each the chat's own or the account default's. */
export function SummarySettings({ session }: { session: ChatSession }) {
  const { view, settings, error, write } = useLcmSettings(session)
  const [open, setOpen] = useOpenPlace(`summary-settings:${session.id}`)
  return (
    <Disclosure title="Summary settings" open={open} onOpenChange={setOpen}>
      <section aria-label="Summary settings" className="flex flex-col gap-4">
        {chatKinds.get(view.chat?.kind ?? "")?.summaryTranscript && (
          <Tooltip label="New workshops start with summaries on. Summarizing sends only this workshop’s conversation and tool steps to the summary connection. Token use and cost appear in Activity.">
            <p tabIndex={0} className="text-sm text-muted">
              Summaries keep earlier messages and tool steps. When on, they use this chat’s summary model and add token
              costs, including during long runs.
            </p>
          </Tooltip>
        )}
        {settings === null ? (
          <Loading />
        ) : (
          <>
            <SummaryModel session={session} account={settings.account} />
            <SlotOutlet
              slot={summarySettingFields}
              props={{
                place: `chat:${session.id}`,
                scope: "chat",
                transcriptOnly: chatKinds.get(view.chat?.kind ?? "")?.summaryTranscript === true,
                view: settings,
                fallback: resolveLcm(null, settings.account),
                write,
                disabled: false,
                instruction: (
                  <Instruction
                    key={view.forkId}
                    targetId={instructionTarget(session.id, view.forkId)}
                    tab={{ chatId: session.id, forkId: view.forkId, leafSlotId: view.leafSlotId }}
                    view={settings}
                    write={write}
                    disabled={false}
                  />
                )
              }}
            />
          </>
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
    <Disclosure title="Advanced: message roles">
      <section aria-label="Roles" className="flex flex-col gap-2">
        <RadioGroup
          aria-label="Message roles"
          value={rolesProjection}
          onValueChange={(projection) => void change({ _tag: "Roles", projection })}
          options={[
            ...(unknownRoles
              ? [
                  {
                    value: unknownRoles,
                    label: `${unknownRoles} (not installed)`,
                    description: "Sent by author until it's back."
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

/**
 * How merged chats are laid out for the model (spec/CHAT-MERGE.md §4), shown once the chat has
 * a merge in the messages loaded, or a layout chosen.
 */
export function MergeLayoutSetting({ session }: { session: ChatSession }) {
  const { cast } = useCast()
  const view = useSyncExternalStore(session.subscribe, session.snapshot)
  const [error, setError] = useState<AppError | null>(null)
  const merged = view.entries.some((entry) => entry.version.origin === "merge")
  if (!cast || (!merged && cast.mergeLayout === undefined)) return null
  const layout = cast.mergeLayout ?? "parallel"
  const options = cast.mergeLayouts ?? []
  const unknown = options.some((option) => option.id === layout) ? null : layout
  const change = async (next: CastChange) => {
    const outcome = await session.changeCast(next)
    setError(outcome.ok ? null : outcome.error)
  }
  return (
    <section aria-label="Merged chats" className="flex flex-col gap-2">
      <Fieldset legend="Merged chats" about="Where the model reads the messages of chats merged into this one.">
        <RadioGroup
          aria-label="Merged chats"
          value={layout}
          onValueChange={(next) => void change({ _tag: "MergeLayout", layout: next })}
          options={[
            ...(unknown
              ? [
                  {
                    value: unknown,
                    label: `${unknown} (not installed)`,
                    description: "Sent in parallel until it's back."
                  }
                ]
              : []),
            ...options.map(({ id, label, description }) => ({ value: id, label, description }))
          ]}
        />
      </Fieldset>
      <Problem error={error} />
    </section>
  )
}

export function ThisChatTab({ session }: { session: ChatSession; active: boolean }) {
  // A kind leaves out the sections it doesn't use (kindLooks.ts): a workshop's tools aren't the story's.
  const kind = useSyncExternalStore(session.subscribe, () => session.snapshot().chat?.kind)
  const look = useChatKindLook(kind)
  return (
    <div className="flex flex-col gap-6">
      <SlotOutlet slot={chatSettingSections} props={{ session }} except={look?.hides ?? []} />
    </div>
  )
}
