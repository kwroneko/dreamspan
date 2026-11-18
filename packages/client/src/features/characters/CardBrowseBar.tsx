import { CardGroupingControl } from "./cardGrouping.tsx"
// The characters' filter and sort in one compact row, for a narrow place: the left panel's
// grid (with Groups and Include personas), Add characters (with Include personas).
// The home page lays the same parts out with CardGridControls. A card source shown (the
// left panel's) takes over the sort, and Filters ends the row.
import { type SourceBrowse, SourceFiltersButton, SourceSortControl } from "../cardSources/browse.tsx"
import { type CardBrowse, CardFilterControl, CardSortControl, IncludePersonas } from "./cardBrowse.tsx"
import { browsable, type ShellLibrary, useGroupCount } from "./shellData.tsx"

type SourceProps = {
  sources?: SourceBrowse | undefined
  onSource?: ((id: string) => void) | undefined
}

function GroupsFilter({
  data,
  browse,
  onChange,
  sources,
  onSource
}: {
  data: ShellLibrary
  browse: CardBrowse
  onChange: (change: Partial<CardBrowse>) => void
} & SourceProps) {
  const groups = useGroupCount()
  return (
    <CardFilterControl
      compact
      archived
      value={browse.filter}
      onChange={(filter) => onChange({ filter })}
      cards={browsable(data)}
      groups={groups}
      withPersonas={browse.withPersonas}
      sources={sources?.options ?? []}
      source={sources?.info?.id ?? null}
      {...(onSource ? { onSource } : {})}
    />
  )
}

export function CardBrowseBar({
  data,
  browse,
  onChange,
  groups = false,
  includePersonas = false,
  families = false,
  sources,
  onSource,
  filtersId = ""
}: {
  data: ShellLibrary
  browse: CardBrowse
  onChange: (change: Partial<CardBrowse>) => void
  /** Offer Groups (chats of several characters) among the filters. */
  groups?: boolean
  /** Offer Include personas at the end of the row, where the filter lists characters. */
  includePersonas?: boolean
  /** Offer Group forks after it, where the list can show a card's family as one tile. */
  families?: boolean
  /** The Filters panel's id, for its button. */
  filtersId?: string
} & SourceProps) {
  const shown = sources?.info ?? null
  return (
    // Wraps where the sidebar is narrowest: the filter keeps room for its choice, and the
    // sort and toggles move to a second line rather than squeezing it.
    <div className="flex max-w-controls min-w-0 shrink-0 flex-wrap items-center gap-1">
      <div className="min-w-24 flex-1">
        {groups ? (
          <GroupsFilter data={data} browse={browse} onChange={onChange} sources={sources} onSource={onSource} />
        ) : (
          <CardFilterControl
            compact
            value={browse.filter}
            onChange={(filter) => onChange({ filter })}
            cards={browsable(data)}
            withPersonas={browse.withPersonas}
            sources={sources?.options ?? []}
            source={shown?.id ?? null}
            {...(onSource ? { onSource } : {})}
          />
        )}
      </div>
      {shown && sources ? (
        <>
          <SourceSortControl compact browse={sources} />
          {includePersonas && (
            <IncludePersonas
              browse={browse}
              onChange={onChange}
              disabledReason={`Personas are your own cards; ${shown.name} lists characters.`}
            />
          )}
          <SourceFiltersButton compact browse={sources} panelId={filtersId} />
        </>
      ) : (
        <>
          <CardSortControl compact sort={browse.sort} reversed={browse.reversed} onChange={onChange} />
          {includePersonas && <IncludePersonas browse={browse} onChange={onChange} />}
          {families && <CardGroupingControl browse={browse} onChange={onChange} />}
        </>
      )}
    </div>
  )
}
