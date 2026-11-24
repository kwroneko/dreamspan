import { archivedCardActions, cardSearchExtras } from "./homeSlots.ts"
import { CenterHeaderContent } from "../../ui/CenterHeader.tsx"
import { useSyncExternalStore } from "react"
import { AsyncView } from "../../actions.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { useTitle } from "../shell.tsx"
import { homeHeaderActions, homeIntro } from "./homeSlots.ts"
import { browseCards, mixesPersonas, useGroupedFamilies } from "./cardBrowse.tsx"
import { useHomeBrowse } from "./useHomeBrowse.ts"
import type { HomeBrowse } from "./homeSearch.ts"
import { SourceResultLine, SourceResults, useSourceBrowse } from "../cardSources/browse.tsx"
import { SourceChips, SourceFiltersPanel, SourceHiddenNote } from "../cardSources/filters.tsx"
import { CardGridControls } from "./CardGridControls.tsx"
import { CardGridEmpty } from "./CardGridEmpty.tsx"
import { GroupGrid } from "./GroupGrid.tsx"
import { browsable, CharacterGrid, shellAtom, type ShellLibrary } from "./shellData.tsx"
import { PinnedChats } from "./ShellBrowser.tsx"

// By Home's own width, not the window's: in a split frame the tiles keep their size rather than
// shrinking to five columns of a narrow frame, where the corner toggles would cover the tile.
const COLUMNS = "grid grid-cols-2 gap-3 @xl:grid-cols-3 @3xl:grid-cols-4 @4xl:grid-cols-5"

function Home({ data }: { data: ShellLibrary }) {
  const [browse, setBrowse] = useHomeBrowse()
  const { search } = browse
  // A card source shown in place of the user's cards; nothing is asked of it otherwise (§5.1).
  const sources = useSourceBrowse(browse.source, browse.remote, (remote, options) => setBrowse({ remote }, options))
  const source = sources.info
  // With nothing imported, what the intro offers (first-run steps) stands in for the empty grid.
  const intro = useSyncExternalStore(homeIntro.subscribe, homeIntro.snapshot).entries.length > 0
  // The source choices also work with an empty library (spec/CARD-SOURCES D1).
  if (
    intro &&
    sources.options.length === 0 &&
    data.cards.length === 0 &&
    data.personas.length === 0 &&
    data.archived.length === 0 &&
    browse.filter !== "personas" &&
    source === null
  )
    return (
      <div className="flex flex-col gap-5">
        <SlotOutlet slot={homeIntro} props={{ data }} />
        <PinnedChats
          pinsCollapsed={data.pinsCollapsed}
          home
          sortBy={browse.pinsSort}
          onSortChange={(pinsSort) => setBrowse({ pinsSort })}
        />
      </div>
    )
  const needle = search.trim().toLowerCase()
  const cards = browseCards(browsable(data), browse, search)
  return (
    <div className="@container flex flex-col gap-5">
      <SlotOutlet slot={homeIntro} props={{ data }} />
      <PinnedChats
        pinsCollapsed={data.pinsCollapsed}
        home
        sortBy={browse.pinsSort}
        onSortChange={(pinsSort) => setBrowse({ pinsSort })}
      />
      <CardGridControls
        data={data}
        browse={browse}
        onChange={setBrowse}
        search={search}
        onSearch={(search) => setBrowse({ search })}
        searchLabel="Search characters and groups"
        sources={sources}
        onSource={(id) => setBrowse({ source: id })}
      />
      {source !== null ? (
        // The source's cards only: never mixed with the user's (spec/CARD-SOURCES.md §3.2).
        <>
          <SourceFiltersPanel browse={sources} id="home-source-filters" filtersButton />
          <SourceChips browse={sources} />
          <SourceResultLine browse={sources} />
          <SourceHiddenNote browse={sources} />
          <SourceResults browse={sources} className={COLUMNS} />
        </>
      ) : (
        <LocalCards data={data} browse={browse} search={search} needle={needle} cards={cards} />
      )}
    </div>
  )
}

function LocalCards({
  data,
  browse,
  search,
  needle,
  cards
}: {
  data: ShellLibrary
  browse: HomeBrowse
  search: string
  needle: string
  cards: ReturnType<typeof browseCards>
}) {
  const [, setBrowse] = useHomeBrowse()
  const grouped = useGroupedFamilies(browse, search)
  return (
    <>
      {browse.filter === "groups" ? (
        <GroupGrid needle={needle} sort={browse.sort} reversed={browse.reversed} className={COLUMNS} />
      ) : (
        <CharacterGrid
          cards={cards}
          sort={browse.sort}
          markPersonas={mixesPersonas(browse)}
          families={grouped ? { expanded: browse.family, onToggle: (family) => setBrowse({ family }) } : undefined}
          className={COLUMNS}
        >
          {!cards.length && <CardGridEmpty filter={browse.filter} needle={needle} place="home" />}
        </CharacterGrid>
      )}
      {/* With archived cards shown, their actions follow the last tile: no row above the grid. */}
      {browse.filter === "archived" && cards.length > 0 && (
        <div>
          <SlotOutlet slot={archivedCardActions} props={{ place: "home" }} />
        </div>
      )}
      <SlotOutlet slot={cardSearchExtras} props={{ data, browse, search, className: COLUMNS }} />
    </>
  )
}

export function CharactersPage() {
  useTitle("Characters")
  return (
    <div className="flex flex-col gap-4">
      <CenterHeaderContent>
        <h1 className="text-xl font-semibold">Characters</h1>
        {/* Right-aligned, just before the header's end controls; hidden with nothing registered.
            On a phone, where the header's padding is 8 px and no end controls follow, the
            bordered button's edge lines up with the page's 16 px gutter as ←'s glyph does. */}
        <div className="ml-auto flex shrink-0 items-center gap-2 empty:hidden max-sm:mr-2">
          <SlotOutlet slot={homeHeaderActions} props={{}} />
        </div>
      </CenterHeaderContent>
      <AsyncView atom={shellAtom} loading="Loading characters…">
        {(data) => <Home data={data} />}
      </AsyncView>
    </div>
  )
}
