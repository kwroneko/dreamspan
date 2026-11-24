// What an empty character grid shows, on Home and in the left panel alike: the app's empty state
// across the grid's whole width (never a tile in its first cell), and the Archived view's
// actions (`archivedCardActions`) as its next step.
import { Link } from "@tanstack/react-router"
import { SlotOutlet } from "../../slots.tsx"
import { EmptyState } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import type { CardBrowse } from "./cardBrowse.tsx"
import { archivedCardActions } from "./homeSlots.ts"

export function CardGridEmpty({
  filter,
  needle,
  place
}: {
  filter: CardBrowse["filter"]
  needle: string
  /** The host ("home", "sidebar"), for the Archived view's actions. */
  place: string
}) {
  const title = needle
    ? "No characters here"
    : filter === "favourites"
      ? "No favourites yet"
      : filter === "archived"
        ? "No archived cards"
        : filter === "personas"
          ? "No personas yet"
          : "No characters here"
  return (
    <div className="col-span-full">
      <EmptyState title={title}>
        {filter === "archived" ? (
          <>
            <p>Archived cards stay here until you unarchive them.</p>
            {!needle && <SlotOutlet slot={archivedCardActions} props={{ place }} />}
          </>
        ) : filter === "favourites" && !needle ? (
          <p>Star a character to keep it here.</p>
        ) : filter === "personas" && !needle ? (
          <p>Cards you play as are kept here. In the library, a card’s menu adds it.</p>
        ) : (
          <Tooltip label="Opens the SillyTavern importer.">
            <Link to="/import/st" className="text-accent">
              Import from SillyTavern
            </Link>
          </Tooltip>
        )}
      </EmptyState>
    </div>
  )
}
