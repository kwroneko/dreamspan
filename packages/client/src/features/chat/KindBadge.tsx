// A chat's kind badge ("Workshop") wherever the chat is named (spec/WORKSHOP.md §2.5): the header,
// the chat lists' rows. Its word and explanation come from the kind's look (kindLooks.ts).
import { Badge } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { useChatKindLook } from "./kindLooks.ts"

/**
 * Nothing for a kind without a badge (a story chat). `inLink`: inside a row's link, which is the
 * tab stop; the badge keeps its explanation on hover and its word in the link's name.
 */
export function KindBadge({ kind, inLink = false }: { kind: string | undefined; inLink?: boolean }) {
  const badge = useChatKindLook(kind)?.badge
  if (badge === undefined) return null
  return (
    <Tooltip label={badge.hint}>
      <span
        {...(inLink ? {} : { tabIndex: 0 })}
        data-kind-badge={kind}
        className="inline-flex shrink-0 rounded-full align-middle outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <Badge>{badge.label}</Badge>
      </span>
    </Tooltip>
  )
}
