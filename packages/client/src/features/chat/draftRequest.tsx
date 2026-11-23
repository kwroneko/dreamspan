import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { defaultsAtom } from "../pickers/defaults.ts"
// A chat not sent yet shows its first request (DESIGN §2.1): the next-reply strip's Context
// chip, with its size and a popover, and the request in an inspector tab (`/request/first`,
// FirstRequestPage.tsx, which reads what the pending chat's view publishes, firstRequest.ts).
// The server builds it with the assembler a send uses and counts it locally (`PreviewChat`):
// nothing is written and nothing goes to a provider. It's asked again, after a pause, whenever
// what the first send would send changes: the greetings picked, the persona, who speaks or
// replies, the text, guidance, the model or the preset.
import type { DraftChatPreview } from "@dreamspan/shared/inspectorApi.ts"
import type { AppRpcs } from "@dreamspan/shared/api.ts"
import type { Rpc } from "effect/rpc"
import { useEffect, useMemo, useRef, useState } from "react"
import { Button } from "../../ui/Button.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { useCaller } from "../editor/caller.ts"
import { ContextPopover } from "./ContextChip.tsx"
import { chipClass } from "./nextReplyStrip.tsx"
import type { PendingComposerContext } from "./pendingComposerControls.tsx"

export type PreviewInput = Rpc.Payload<Extract<AppRpcs, { readonly _tag: "PreviewChat" }>>

/** The pending chat's first request, as the chip and its inspector tab read it. */
export interface DraftPreviewState {
  readonly preview: DraftChatPreview | null
  readonly loading: boolean
  readonly error: string | null
  /** Opens the request in its inspector tab. */
  readonly openRequest: () => void
  /** That tab's URL, for the link's open menu and a middle click. */
  readonly requestHref?: string
}

/** How long typing pauses before the request is built again. */
const PAUSE_MS = 400

/**
 * The first request for `input`, built again `PAUSE_MS` after it last changed; `key` names what
 * else it depends on (the model and the preset). Null input: nothing is asked yet. One request
 * at a time: a change while one is out is asked for when it returns, so a slow build (a huge
 * greeting) never piles up reads ahead of the first send.
 */
export function useDraftPreview(
  input: PreviewInput | null,
  key: string,
  openRequest: () => void,
  requestHref?: string
): DraftPreviewState {
  const call = useCaller()
  // The same account selection the model/preset chips read, invalidated by settings and
  // library changes. Its timestamp also catches a saved note/book whose id stays the same.
  const defaults = useAtomValue(defaultsAtom)
  const revision = AsyncResult.isSuccess(defaults) ? defaults.timestamp : null
  const asked = input === null ? null : JSON.stringify([input, key, revision])
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
    preview: state.asked === asked ? state.preview : null,
    loading: asked !== null && state.asked !== asked,
    error: state.asked === asked ? state.error : null,
    openRequest,
    ...(requestHref === undefined ? {} : { requestHref })
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
  const budget = preview.budget ?? null
  // The chat's own messages don't exist yet: no "messages fit" line.
  return (
    <ContextPopover
      open={open}
      onOpenChange={setOpen}
      request="first"
      tokens={preview.size?.tokens ?? tokensOf(preview)}
      maximum={budget?.maximum ?? null}
      reserve={budget?.responseReserve ?? 0}
      loading={loading}
      parts={preview.size?.parts ?? []}
      messages={null}
      tokenizer={preview.size?.tokenizer ?? preview.request.tokenizer}
      onViewRequest={draft.openRequest}
      {...(draft.requestHref === undefined ? {} : { requestHref: draft.requestHref })}
    />
  )
}
