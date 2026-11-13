// A chat not sent yet shows its first request (DESIGN §2.1): the next-reply strip's Context
// chip, with its size and a popover, and the request in a dialog (`request=first` in the URL).
// The server builds it with the assembler a send uses and counts it locally (`PreviewChat`):
// nothing is written and nothing goes to a provider. It's asked again, after a pause, whenever
// what the first send would send changes: the greetings picked, the persona, who speaks or
// replies, the text, guidance, the model or the preset.
import type { DraftChatPreview } from "@rp/shared/inspectorApi.ts"
import type { AppRpcs } from "@rp/shared/api.ts"
import type { Rpc } from "effect/rpc"
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "../../ui/Button.tsx"
import { Dialog } from "../../ui/Dialog.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { Loading } from "../../ui/Spinner.tsx"
import { useCaller } from "../editor/caller.ts"
import { tokenizerText } from "../editor/tokenCounts.ts"
import { compactTokens } from "./CacheIndicator.tsx"
import { chipClass } from "./nextReplyStrip.tsx"
import type { PendingComposerContext } from "./pendingComposerControls.tsx"

// The inspector's views load when the dialog opens, not with every pending chat.
const DraftRequestView = lazy(() => import("./ContextPage.tsx").then((m) => ({ default: m.DraftRequestView })))

export type PreviewInput = Rpc.Payload<Extract<AppRpcs, { readonly _tag: "PreviewChat" }>>

/** The pending chat's first request, as the chip and the dialog read it. */
export interface DraftPreviewState {
  readonly preview: DraftChatPreview | null
  readonly loading: boolean
  readonly error: string | null
  /** Opens the request in its dialog. */
  readonly openRequest: () => void
}

/** How long typing pauses before the request is built again. */
const PAUSE_MS = 400

/**
 * The first request for `input`, built again `PAUSE_MS` after it last changed; `key` names what
 * else it depends on (the model and the preset). Null input: nothing is asked yet. One request
 * at a time: a change while one is out is asked for when it returns, so a slow build (a huge
 * greeting) never piles up reads ahead of the first send.
 */
export function useDraftPreview(input: PreviewInput | null, key: string, openRequest: () => void): DraftPreviewState {
  const call = useCaller()
  const asked = input === null ? null : JSON.stringify([input, key])
  const [state, setState] = useState<{ asked: string | null; preview: DraftChatPreview | null; error: string | null }>({
    asked: null,
    preview: null,
    error: null
  })
  // The latest input to ask for, and whether a request is out.
  const latest = useRef<{ asked: string; input: PreviewInput } | null>(null)
  const out = useRef(false)
  const unmounted = useRef(false)
  useEffect(
    () => () => {
      unmounted.current = true
    },
    []
  )
  const ask = useMemo(() => {
    const run = () => {
      const next = latest.current
      if (out.current || next === null) return
      out.current = true
      void call((client) => client("PreviewChat", next.input)).then((result) => {
        out.current = false
        if (unmounted.current) return
        setState(
          result.ok
            ? { asked: next.asked, preview: result.value, error: null }
            : { asked: next.asked, preview: null, error: result.error.message }
        )
        if (latest.current !== null && latest.current.asked !== next.asked) run()
      })
    }
    return run
  }, [call])
  useEffect(() => {
    latest.current = asked === null || input === null ? null : { asked, input }
    if (latest.current === null) return
    const timer = setTimeout(ask, PAUSE_MS)
    return () => clearTimeout(timer)
    // `asked` is the input's contents: a new object with the same contents asks nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, ask])
  return {
    preview: state.preview,
    loading: asked !== null && state.asked !== asked,
    error: state.asked === asked ? state.error : null,
    openRequest
  }
}

const tokensOf = (preview: DraftChatPreview) => preview.request?.messages.reduce((sum, m) => sum + m.tokens, 0) ?? 0

/** The strip's Context chip of a chat not sent yet: its first request's size, and the request. */
export function DraftContextChip({ draft }: PendingComposerContext) {
  const [open, setOpen] = useState(false)
  const { preview, loading, error } = draft
  const failed = error ?? preview?.assemblyError ?? null
  if (preview === null && failed === null)
    return (
      <Button
        variant="ghost"
        aria-label="Context size unavailable"
        className={chipClass()}
        disabled
        focusableWhenDisabled
        hint={loading ? "Working out the size of your first request…" : "The first request's size shows here."}
      >
        Context
      </Button>
    )
  if (failed !== null || preview === null || preview.request === null)
    return (
      <Popover
        open={open}
        onOpenChange={setOpen}
        trigger={<span>Context</span>}
        triggerLabel="Context: your first request can't be built. Why"
        hint="Why your first request can't be built yet"
        triggerClassName={chipClass("warning")}
        title="Context"
      >
        <p className="text-sm">{failed ?? "Choose a model for this chat to see what your first send would send."}</p>
      </Popover>
    )
  const tokens = tokensOf(preview)
  const budget = preview.budget ?? null
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={<span className={loading ? "opacity-60" : ""}>~{compactTokens(tokens)} tokens</span>}
      triggerLabel={`Context: about ${tokens.toLocaleString()} tokens in your first request. Details`}
      hint="The size of what your first send would send to the model"
      triggerClassName={chipClass()}
      title="Context"
    >
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto text-sm">
        <p>
          About {tokens.toLocaleString()} tokens: what your first send would send
          {preview.request.model ? ` to ${preview.request.model.model}` : ""}, with the greetings, your message and the
          instructions for the reply.
        </p>
        {budget && (
          <p className="text-muted">
            The model's context holds {budget.maximum.toLocaleString()} tokens;{" "}
            {budget.responseReserve.toLocaleString()} are kept for the reply.
          </p>
        )}
        <p className="text-xs text-muted">
          {preview.request.tokenizer ? tokenizerText(preview.request.tokenizer) : "An estimate."} Counted here: nothing
          is sent until you send.
        </p>
        <Button
          className="self-start"
          hint="Opens the request your first send would make, message by message."
          onClick={() => {
            setOpen(false)
            draft.openRequest()
          }}
        >
          View request
        </Button>
      </div>
    </Popover>
  )
}

/** The first request in a dialog, the inspector's way. */
export function DraftRequestDialog({
  open,
  onClose,
  draft
}: {
  open: boolean
  onClose: () => void
  draft: DraftPreviewState
}) {
  const request = draft.preview?.request ?? null
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      title="Your first request"
      description="What your first send would send to the model, built now. Nothing has been sent."
      wide
    >
      {request !== null ? (
        <Suspense fallback={<Loading label="Loading the request…" />}>
          <DraftRequestView request={request} />
        </Suspense>
      ) : draft.loading ? (
        <Loading label="Building the request…" />
      ) : (
        <p className="text-sm">
          {draft.error ?? draft.preview?.assemblyError ?? "Choose a model for this chat to see its first request."}
        </p>
      )}
    </Dialog>
  )
}
