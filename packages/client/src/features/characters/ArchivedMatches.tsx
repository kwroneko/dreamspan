import { useState } from "react"
import { Button } from "../../ui/Button.tsx"
import { browseCards, type CardBrowse } from "./cardBrowse.tsx"
import { browsable, CharacterGrid, type ShellLibrary } from "./shellData.tsx"

export function ArchivedMatches({
  data,
  browse,
  search,
  className
}: {
  data: ShellLibrary
  browse: CardBrowse
  search: string
  className: string
}) {
  const [open, setOpen] = useState(false)
  const cards = browseCards(browsable(data), { ...browse, filter: "archived" }, search)
  if (browse.filter !== "all" || !search.trim() || !cards.length) return null
  return (
    <section className="flex flex-col gap-2">
      <Button
        variant="ghost"
        className="self-start"
        aria-expanded={open}
        hint={open ? "Click to hide archived search matches" : "Click to show archived cards matching this search"}
        onClick={() => setOpen(!open)}
      >
        Archived ({cards.length.toLocaleString()})
      </Button>
      {open && <CharacterGrid cards={cards} sort={browse.sort} className={className} />}
    </section>
  )
}
