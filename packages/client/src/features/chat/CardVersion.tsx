// A card's version (its subtitle, `character_version`) under its name where a chat lists cards:
// the Cast tab and the speaker and persona pickers (CARD-FORKS surface 5; audit item 016), so two
// cards with the same name, a card and its fork say, can be told apart, as on the home grid.
import type { CastCard } from "@dreamspan/shared/chat.ts"

export function CardVersion({ card, truncate = false }: { card: CastCard; truncate?: boolean }) {
  const version = card.subtitle?.trim() ?? ""
  if (version === "") return null
  return (
    <span
      data-card-version
      title={`Version: ${version}`}
      data-layout-name
      className={`max-w-full text-xs text-muted ${truncate ? "truncate" : "[overflow-wrap:anywhere]"}`}
    >
      {version}
    </span>
  )
}

/** A compact choice keeps the real display name and standard card version together. */
export const cardChoiceLabel = (card: Pick<CastCard, "name" | "subtitle">) =>
  card.subtitle?.trim() ? `${card.name} · ${card.subtitle.trim()}` : card.name
