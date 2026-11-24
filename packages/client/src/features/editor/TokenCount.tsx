// A text box's token count, at the start of the strip inside its border (ui/FieldFrame.tsx):
// a card field's, and any other editor's that counts its text the same way (a message's
// thinking). Counted with the model's tokenizer once typing rests (tokenCounts.ts).
import { useMemo } from "react"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { type CountModel, tokenizerText, tokensText, useTokenCounts } from "./tokenCounts.ts"

export function TokenCount({
  text,
  about,
  model
}: {
  /** The text counted, as the model would get it. */
  text: string
  /** What is counted, before the tokenizer's name in its explanation. */
  about: string
  /** The model whose tokenizer counts it; none: the account's. */
  model?: CountModel | undefined
}) {
  const texts = useMemo(() => [text], [text])
  const { counts, tokenizer, pending } = useTokenCounts(texts, model)
  const full = tokensText(counts[0] ?? null, tokenizer, pending)
  // In a narrow box's strip (FieldFrame's container under 24rem) only the number shows, at
  // every state, so it fits beside "edited" and the box's controls; the hover gives it whole.
  const unit = full.endsWith(" tokens") ? " tokens" : ""
  return (
    <Tooltip label={`${full}. ${about} ${tokenizerText(tokenizer)}`}>
      <span
        tabIndex={0}
        data-field-tokens
        aria-busy={pending || undefined}
        className="rounded text-xs font-normal whitespace-nowrap text-muted tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {full.slice(0, full.length - unit.length)}
        {unit && <span className="@max-sm/field-strip:sr-only">{unit}</span>}
      </span>
    </Tooltip>
  )
}
