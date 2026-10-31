// The next-reply strip above the composer's box: small chips for what the next reply uses (the
// model, the prompt preset, the cache, who replies), each opening a popover of full-width rows,
// the same popover at every width, so a long name is never cut to "Local …".
import { type ReactNode, useId, useRef, useState } from "react"
import { Input } from "../../ui/Field.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Popover } from "../../ui/Popover.tsx"

type ChipTone = "neutral" | "warning" | "success"

const chipTones: Record<ChipTone, string> = {
  neutral: "border-border text-text",
  warning: "border-warning/50 bg-warning/5 text-warning",
  success: "border-success/40 text-success"
}

/** A strip chip's look: a pill, one line, its text cut with an ellipsis when it's long. */
export const chipClass = (tone: ChipTone = "neutral") =>
  `inline-flex h-7 max-w-56 min-w-0 shrink-0 max-sm:max-w-36 items-center gap-1 rounded-full border px-2.5 text-xs font-medium whitespace-nowrap outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent ${chipTones[tone]}`

/** A chip whose value isn't known yet: "…", disabled, never a placeholder that flashes first. */
export function LoadingChip({ label }: { label: string }) {
  return (
    <button type="button" disabled aria-label={`${label}: loading`} className={chipClass()}>
      …
    </button>
  )
}

/** The chip's text and a ▾: what the popover changes. */
export function ChipText({ children }: { children: ReactNode }) {
  return (
    <>
      <span className="min-w-0 truncate">{children}</span>
      <Icon name="down" size={12} className="text-muted" />
    </>
  )
}

/** A full-width row in a strip popover, for the action under the choices ("Model settings…"). */
export function PopoverRow({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-accent outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus"
    >
      {children}
    </button>
  )
}

export interface StripChoice<Value> {
  readonly value: Value
  readonly label: string
  /** A second line, muted. */
  readonly detail?: string
}

const fold = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()

/**
 * A chip that opens one choice among several (radio semantics), each a full-width row that wraps
 * rather than truncates; a search field on top when there are many. `footer` gets `close`.
 */
export function ChoiceChip<Value>({
  label,
  title,
  chip,
  hint,
  choices,
  value,
  onChoose,
  footer
}: {
  /** The trigger's accessible name. */
  label: string
  title: string
  chip: ReactNode
  hint?: ReactNode
  choices: ReadonlyArray<StripChoice<Value>>
  value: Value
  onChoose: (value: Value) => void
  footer?: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const search = useRef<HTMLInputElement>(null)
  const listId = useId()
  const searchable = choices.length > 8
  const q = fold(query.trim())
  const shown = q === "" ? choices : choices.filter((choice) => fold(choice.label).includes(q))
  const close = () => setOpen(false)
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        setQuery("")
      }}
      trigger={chip}
      triggerLabel={label}
      hint={hint}
      title={title}
      triggerClassName={chipClass()}
      {...(searchable ? { initialFocus: search } : {})}
    >
      {searchable && (
        <Input
          ref={search}
          type="search"
          aria-label={`Find in ${title.toLowerCase()}`}
          aria-controls={listId}
          placeholder="Find by name"
          autoComplete="off"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          className="shrink-0"
        />
      )}
      <div id={listId} role="radiogroup" aria-label={title} className="flex min-h-0 flex-col overflow-y-auto">
        {shown.length === 0 && <p className="px-2 py-1.5 text-sm text-muted">Nothing is called “{query.trim()}”.</p>}
        {shown.map((choice) => {
          const checked = Object.is(choice.value, value)
          return (
            <button
              key={String(choice.value)}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={choice.label}
              {...(choice.detail ? { "aria-description": choice.detail } : {})}
              onClick={() => {
                close()
                if (!checked) onChoose(choice.value)
              }}
              className="grid w-full shrink-0 grid-cols-[1rem_1fr] items-start gap-x-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus aria-checked:font-medium"
            >
              <span className="pt-0.5 text-accent">{checked && <Icon name="check" size={14} />}</span>
              <span className="min-w-0 [overflow-wrap:anywhere]">{choice.label}</span>
              {choice.detail && (
                <span className="col-start-2 text-xs font-normal text-muted [overflow-wrap:anywhere]">
                  {choice.detail}
                </span>
              )}
            </button>
          )
        })}
      </div>
      {footer && <div className="flex shrink-0 flex-col border-t border-border pt-1">{footer(close)}</div>}
    </Popover>
  )
}
