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
  const count = counts[0] ?? null
  const full = tokensText(count, tokenizer, pending)
  // In a narrow box's strip (FieldFrame's container under 24rem) it shows short ("~1.2k"),
  // edited or not, so it fits beside "edited" and the box's controls; the hover gives it whole.
  const short =
    count === null
      ? "…"
      : `${full.startsWith("~") ? "~" : ""}${count.toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 1 })}`
  return (
    <Tooltip label={`${full}. ${about} ${tokenizerText(tokenizer)}`}>
      <span
        tabIndex={0}
        data-field-tokens
        aria-busy={pending || undefined}
        className="rounded text-xs font-normal whitespace-nowrap text-muted tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <span className="@max-sm/field-strip:sr-only">{full}</span>
        {/* Drawn, not text: the count's text stays its whole wording. */}
        <span aria-hidden data-short={short} className="@max-sm/field-strip:before:content-[attr(data-short)]" />
      </span>
    </Tooltip>
  )
}
