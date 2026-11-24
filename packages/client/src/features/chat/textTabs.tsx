// A chat's own texts in workbench tabs of their own (owner, 2026-11-23: no expand is lost; the
// URLs are fieldTab.ts's): a summary's text, the same draft as its edit in the summaries panel,
// and the chat's summarization instruction, the same draft as its box under Summary settings.
// Each box fills the tab and scrolls inside, as a library field's does (editor/FieldPage.tsx).
// Saving stays where it was: the panel's Save, which uses what's typed here.
import { chatName } from "@dreamspan/shared/chatName.ts"
import type { ChatId, ForkId, SlotId } from "@dreamspan/shared/chat.ts"
import { BUILTIN_SUMMARY_INSTRUCTION } from "@dreamspan/shared/lcmSettings.ts"
import type { LcmSettingsView, Summary } from "@dreamspan/shared/lcm.ts"
import { importState } from "@dreamspan/shared/stImportApi.ts"
import { useLocation } from "@tanstack/react-router"
import { type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { useSession } from "../../session.ts"
import { SlotOutlet } from "../../slots.tsx"
import { Button } from "../../ui/Button.tsx"
import { CenterHeaderContent } from "../../ui/CenterHeader.tsx"
import { CodeEditor } from "../../ui/CodeEditor.tsx"
import { Loading } from "../../ui/Spinner.tsx"
import { Alert } from "../../ui/Surface.tsx"
import { useCaller } from "../editor/caller.ts"
import {
  INSTRUCTION_LABEL,
  type InstructionTabTarget,
  instructionTabTarget,
  fieldTabName,
  type SummaryTabTarget,
  summaryTabTarget
} from "../editor/fieldTab.ts"
import { UserDraftNotices, UserDraftUndo, useUserDraft } from "../editor/userDraft.tsx"
import { useTitle } from "../shell.tsx"
import { useTabRegion } from "../workbench/tab.tsx"
import { summaryEditorTools, summaryTextEditor } from "./editorHistory.tsx"
import { INSTRUCTION_FIELD, instructionTarget } from "./instructionDraft.ts"
import { type SummaryDraftHost, useSharedSummaryDraft } from "./summaryDraft.ts"
import { SummaryDraftStatus, summaryTextLabel, useSummaryBase } from "./summaryEdit.tsx"

const useTarget = <A,>(read: (url: URL) => A | null) =>
  read(new URL(useLocation({ select: (location) => location.href }), "http://tab.invalid"))

/** The chat's name, for the tab's title, once it's read. */
function useChatName(chatId: string) {
  const call = useCaller()
  const [name, setName] = useState("")
  useEffect(() => {
    let live = true
    void call((client) => client("GetChat", { chatId: chatId as ChatId })).then((result) => {
      if (live && result.ok) setName(chatName(importState(result.value.title).title, []).name)
    })
    return () => {
      live = false
    }
  }, [call, chatId])
  return name
}

/** The server for a draft of the chat, read on the branch the URL names. */
function useHost(forkId: string | null): SummaryDraftHost {
  const call = useCaller()
  return useMemo(() => ({ call, snapshot: () => ({ forkId: forkId as ForkId | null }) }), [call, forkId])
}

/** The tab's page: its title in the header, its box filling the rest. */
function TextTab({ title, children }: { title: string; children: ReactNode }) {
  useTitle(title)
  const inTab = useTabRegion(title)
  const body = (
    <div className="flex min-h-0 flex-1 flex-col p-3 sm:p-4">
      <div data-field-tab className="flex min-h-0 flex-1 flex-col gap-2">
        {children}
      </div>
    </div>
  )
  return (
    <>
      <CenterHeaderContent>
        <h1 className="min-w-0 truncate text-base font-semibold">{title}</h1>
      </CenterHeaderContent>
      {inTab ? (
        <div className="flex min-h-0 flex-1 flex-col">{body}</div>
      ) : (
        <section aria-label={title} className="flex min-h-0 flex-1 flex-col">
          {body}
        </section>
      )}
    </>
  )
}

function Retry({ error, label, onRetry }: { error: AppError; label: string; onRetry: () => void }) {
  return (
    <ErrorAlert
      error={error}
      actions={
        <Button hint={`Retries loading ${label}.`} variant="ghost" onClick={onRetry}>
          Try again
        </Button>
      }
    />
  )
}

function SummaryText({ target, summary }: { target: SummaryTabTarget; summary: Summary }) {
  const host = useHost(target.forkId)
  const userId = useSession().user.id
  // The same draft as the summary's edit in the panel, when that's open.
  const store = useSharedSummaryDraft(host, userId, summary)
  const view = useSyncExternalStore(store.subscribe, store.snapshot)
  useEffect(() => store.update(summary), [store, summary])
  const { base, problem, retry } = useSummaryBase(host, store)
  return (
    <>
      <SlotOutlet
        slot={summaryTextEditor}
        props={{
          label: summaryTextLabel(summary),
          value: view.text,
          base: base ?? "",
          readOnly: view.loading || base === null,
          onChange: (value) => store.setText(value),
          fill: true,
          minHeight: "100%"
        }}
      />
      <SummaryDraftStatus view={view} fresh={summary.fresh} />
      {base !== null && <SlotOutlet slot={summaryEditorTools} props={{ draft: store, base }} />}
      {base === null && problem && <Retry error={problem} label="the saved text" onRetry={retry} />}
      {view.error && <Alert tone="danger">{view.error.message}</Alert>}
    </>
  )
}

/** A summary's text in its own tab (`/chats/<chat>/summaries/<id>/text`). */
export function SummaryTextPage() {
  const target = useTarget(summaryTabTarget)
  const call = useCaller()
  const [loaded, setLoaded] = useState<{ forkId: string | null; summary: Summary } | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [attempt, setAttempt] = useState(0)
  const chat = useChatName(target?.chatId ?? "")
  const forkId = target?.forkId ?? null
  const summaryId = target?.summaryId ?? ""
  const summary = loaded?.forkId === forkId && loaded.summary.id === summaryId ? loaded.summary : null
  useEffect(() => {
    if (!summaryId) return
    let live = true
    void call((client) =>
      client("GetSummary", { forkId: forkId as ForkId | null, summaryId: summaryId as Summary["id"] })
    ).then((result) => {
      if (!live) return
      if (result.ok) {
        setLoaded({ forkId, summary: result.value })
        setError(null)
      } else setError(result.error)
    })
    return () => {
      live = false
    }
  }, [call, forkId, summaryId, attempt])
  if (!target) return <Alert tone="warning">This link doesn&apos;t name a summary.</Alert>
  const title = fieldTabName(chat, target.label)
  return (
    <TextTab title={title}>
      {error?.tag === "NotFound" ? (
        <Alert tone="warning">This summary is no longer available on this branch.</Alert>
      ) : error ? (
        <Retry error={error} label="the summary" onRetry={() => setAttempt((n) => n + 1)} />
      ) : summary === null ? (
        <Loading label="Opening the summary…" />
      ) : (
        <SummaryText key={`${summary.id}:${forkId ?? ""}`} target={target} summary={summary} />
      )}
    </TextTab>
  )
}

function InstructionText({ target, settings }: { target: InstructionTabTarget; settings: LcmSettingsView }) {
  const saved = settings.resolved.tail ?? BUILTIN_SUMMARY_INSTRUCTION
  // The same draft as the box under This chat → Summary settings.
  const draft = useUserDraft(instructionTarget(target.chatId, target.forkId), INSTRUCTION_FIELD, saved)
  return (
    <>
      <CodeEditor
        label="This chat's summarization instruction"
        value={draft.text}
        base={saved}
        rows={5}
        fill
        minHeight="100%"
        onChange={draft.setText}
        tools={<UserDraftUndo draft={draft} />}
      />
      <p className="text-xs text-muted" aria-live="polite">
        {"{{words}} is the summary length."}
        {draft.text !== saved && " Not saved yet: Save instruction under This chat → Summary settings uses it."}
      </p>
      <UserDraftNotices draft={draft} />
    </>
  )
}

/** A chat's summarization instruction in its own tab (`/chats/<chat>/instruction`). */
export function InstructionTabPage() {
  const target = useTarget(instructionTabTarget)
  const call = useCaller()
  const [settings, setSettings] = useState<LcmSettingsView | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [attempt, setAttempt] = useState(0)
  const chat = useChatName(target?.chatId ?? "")
  const chatId = target?.chatId ?? ""
  const forkId = target?.forkId ?? null
  const leafSlotId = target?.leafSlotId ?? null
  useEffect(() => {
    if (!chatId) return
    let live = true
    void call((client) =>
      client("GetLcmSettings", {
        chatId: chatId as ChatId,
        forkId: forkId as ForkId | null,
        leafSlotId: leafSlotId as SlotId | null
      })
    ).then((result) => {
      if (!live) return
      if (result.ok) {
        setSettings(result.value)
        setError(null)
      } else setError(result.error)
    })
    return () => {
      live = false
    }
  }, [call, chatId, forkId, leafSlotId, attempt])
  if (!target) return <Alert tone="warning">This link doesn&apos;t name a chat.</Alert>
  return (
    <TextTab title={fieldTabName(chat, INSTRUCTION_LABEL)}>
      {error ? (
        <Retry error={error} label="the instruction" onRetry={() => setAttempt((n) => n + 1)} />
      ) : settings === null ? (
        <Loading label="Opening the instruction…" />
      ) : (
        <InstructionText target={target} settings={settings} />
      )}
    </TextTab>
  )
}
