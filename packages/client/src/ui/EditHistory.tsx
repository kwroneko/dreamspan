// A text box's edit history (owner, 2026-11-01), apart from revision History: every state the box
// had, from any device or session, browsable with its text. Picking one puts it in the box as a
// new latest state, so the text there now stays in the list: no travelling back, no branches, no
// redo. It's for recovery (a refresh, another device, an accident); the box's own Ctrl+Z is the
// everyday undo. Editors bind it to their drafts (`load`, `read`, `restore`).
import { useEffect, useState } from "react"
import { Button } from "./Button.tsx"
import { Dialog, DialogActions } from "./Dialog.tsx"
import { Alert } from "./Surface.tsx"
import { IconButton } from "./Tooltip.tsx"

export interface EditState {
  readonly seq: number
  readonly at: number
  readonly length: number
  readonly kind: "initial" | "edit" | "restore" | "revision"
}

/** What a call gave: its value, or why not, in words. */
export type Loaded<A> =
  { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: { readonly message: string } }

/** How many states a page of the list holds. */
const PAGE = 50

const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })

const kindLabel: Record<EditState["kind"], string> = {
  initial: "First kept state",
  edit: "Typed",
  restore: "Put back from this list",
  revision: "Text of a restored or updated revision"
}

export function EditHistory({
  label,
  load,
  read,
  restore,
  disabled = false
}: {
  /** The box's name: "Description". */
  label: string
  /** A page of states, newest first; `before` continues past a seq. */
  load: (before?: number) => Promise<Loaded<ReadonlyArray<EditState>>>
  /** One state's whole text. */
  read: (seq: number) => Promise<Loaded<string>>
  /** Puts that state in the box as the newest one. */
  restore: (seq: number) => Promise<Loaded<unknown>>
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <IconButton
        label={`Edit history of ${label}`}
        hint="Edit history: every earlier state of this text, from any device. Picking one puts it back as the newest state; nothing is lost."
        icon="history"
        disabled={disabled}
        onClick={() => setOpen(true)}
      />
      {open && (
        <EditHistoryDialog label={label} load={load} read={read} restore={restore} onClose={() => setOpen(false)} />
      )}
    </>
  )
}

function EditHistoryDialog({
  label,
  load,
  read,
  restore,
  onClose
}: {
  label: string
  load: (before?: number) => Promise<Loaded<ReadonlyArray<EditState>>>
  read: (seq: number) => Promise<Loaded<string>>
  restore: (seq: number) => Promise<Loaded<unknown>>
  onClose: () => void
}) {
  const [states, setStates] = useState<ReadonlyArray<EditState> | null>(null)
  const [more, setMore] = useState(false)
  const [selected, setSelected] = useState<EditState | null>(null)
  const [shown, setRead] = useState<{ readonly seq: number; readonly text: string } | null>(null)
  const text = selected !== null && shown?.seq === selected.seq ? shown.text : null
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  useEffect(() => {
    let live = true
    void load().then((result) => {
      if (!live) return
      if (!result.ok) return setError(result.error.message)
      setStates(result.value)
      setMore(result.value.length >= PAGE)
      if (result.value[1]) setSelected(result.value[1])
    })
    return () => {
      live = false
    }
  }, [load])
  useEffect(() => {
    if (selected === null) return
    let live = true
    void read(selected.seq).then((result) => {
      if (!live) return
      if (result.ok) setRead({ seq: selected.seq, text: result.value })
      else setError(result.error.message)
    })
    return () => {
      live = false
    }
  }, [read, selected])
  const earlier = async () => {
    if (!states?.length) return
    setPending(true)
    const result = await load(states.at(-1)!.seq)
    setPending(false)
    if (!result.ok) return setError(result.error.message)
    setStates([...states, ...result.value])
    setMore(result.value.length >= PAGE)
  }
  const put = async () => {
    if (selected === null) return
    setPending(true)
    const result = await restore(selected.seq)
    setPending(false)
    if (result.ok) onClose()
    else setError(result.error.message)
  }
  return (
    <Dialog
      wide
      open
      onOpenChange={(next) => !next && onClose()}
      title={`Edit history: ${label}`}
      description="Every state this text had, newest first, from any device or session. Putting one back makes it the newest state; the text there now stays in this list. Revisions are in History."
    >
      {error && <Alert tone="danger">{error}</Alert>}
      {states === null && error === null && <p className="text-sm text-muted">Loading…</p>}
      {states !== null && (
        <div className="grid min-h-0 gap-3 sm:grid-cols-[minmax(12rem,18rem)_1fr]">
          <div className="flex min-w-0 flex-col gap-2">
            <ol aria-label="Earlier states" className="flex max-h-[40dvh] flex-col overflow-y-auto sm:max-h-[55dvh]">
              {states.map((state, index) => (
                <li key={state.seq}>
                  <button
                    type="button"
                    aria-pressed={selected?.seq === state.seq}
                    onClick={() => setSelected(state)}
                    className="flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus aria-pressed:bg-surface-raised"
                  >
                    <span className="font-medium">{index === 0 ? `Latest · ${when(state.at)}` : when(state.at)}</span>
                    <span className="text-xs text-muted">
                      {kindLabel[state.kind]} · {state.length} characters
                    </span>
                  </button>
                </li>
              ))}
            </ol>
            {more && (
              <Button pending={pending} hint="Lists the states before these." onClick={() => void earlier()}>
                Earlier states
              </Button>
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            {selected === null ? (
              <p className="text-sm text-muted">Pick a state to read its text.</p>
            ) : text === null ? (
              <p className="text-sm text-muted">Loading its text…</p>
            ) : (
              <pre
                aria-label="Text of the state"
                className="max-h-[40dvh] min-h-24 overflow-auto rounded-md border border-border bg-canvas p-2 font-sans text-sm whitespace-pre-wrap [overflow-wrap:anywhere] sm:max-h-[55dvh]"
              >
                {text === "" ? <span className="text-muted">(empty)</span> : text}
              </pre>
            )}
          </div>
        </div>
      )}
      <DialogActions>
        <Button onClick={onClose} hint="Closes the edit history; the box stays as it is.">
          Close
        </Button>
        <Button
          variant="primary"
          pending={pending}
          disabled={selected === null || text === null || selected.seq === states?.[0]?.seq}
          hint="Puts this text in the box as its newest state. The text there now stays in this list."
          onClick={() => void put()}
        >
          Put this text in the box
        </Button>
      </DialogActions>
    </Dialog>
  )
}
