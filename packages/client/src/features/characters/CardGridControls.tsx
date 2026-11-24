import { CardGroupingControl } from "./cardGrouping.tsx"
// Shared by the registered home and sidebar character grids. Measure intrinsic controls,
// then let container queries place them without depending on the window or sidebar width.
// A card source shown takes over the search, the sort and a Filters button at the row's end.
import { useId, useLayoutEffect, useRef } from "react"
import { Input } from "../../ui/Field.tsx"
import { type SourceBrowse, SourceSortControl } from "../cardSources/browse.tsx"
import { SourceSearchOptions } from "../cardSources/filters.tsx"
import { type CardBrowse, CardFilterControl, CardSortControl, IncludePersonas } from "./cardBrowse.tsx"
import { browsable, type ShellLibrary, useGroupCount } from "./shellData.tsx"

export function CardGridControls({
  data,
  browse,
  onChange,
  search,
  onSearch,
  searchLabel,
  sources,
  onSource,
  filtersId
}: {
  data: ShellLibrary
  browse: CardBrowse
  onChange: (change: Partial<CardBrowse>) => void
  search: string
  onSearch: (search: string) => void
  searchLabel: string
  /**
   * The card sources Show offers; while one is shown, the search and sort work on it
   * (spec/CARD-SOURCES.md §3.2), and Include personas and Group forks stay, disabled: every tab
   * shows the same buttons in the same places, so none leaves a gap or moves the sort.
   */
  sources?: SourceBrowse | undefined
  onSource?: (id: string) => void
  /**
   * The source's filter bar's id: its search options and (on a narrow bar) its Filters button
   * then follow the search box, on its row (the box shrinks first).
   */
  filtersId?: string | undefined
}) {
  const shown = sources?.info ?? null
  const name = `card-grid-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`
  const root = useRef<HTMLDivElement>(null)
  const groups = useGroupCount()
  useLayoutEffect(() => {
    const sheet = new CSSStyleSheet()
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
    const node = root.current!
    const filters = node.querySelector<HTMLElement>('.card-grid-filter [role="group"]')!
    const sort = node.querySelector<HTMLElement>(".card-grid-sort > *")!
    const search = node.querySelector<HTMLElement>(".card-grid-search-size")!
    // A scrollbar takes room below what it scrolls (none where scrollbars overlay the content).
    const probe = document.createElement("div")
    probe.style.cssText = "position:absolute;visibility:hidden;overflow-x:scroll;width:50px;height:50px"
    node.append(probe)
    const bar = probe.offsetHeight - probe.clientHeight
    probe.remove()
    const measure = () => {
      // The filters and the sort's choices scroll where they don't fit. Their scrollbar's room is
      // kept while it doesn't show, so a tab whose choices or counts are longer (a card source's)
      // moves nothing below them.
      for (const scroller of node.querySelectorAll<HTMLElement>("[data-scroll-keep]"))
        scroller.toggleAttribute("data-scrolling", scroller.scrollWidth > scroller.clientWidth)
      const gap = parseFloat(getComputedStyle(node.querySelector(".card-grid-controls")!).columnGap)
      const sortWidth = sort.getBoundingClientRect().width
      // With a source's search options beside the box, the row holds the box at its smallest
      // (8rem), the options, and the sort, whose choices scroll before anything wraps.
      const options = node.querySelector<HTMLElement>("[data-search-options]")
      const medium = options
        ? Math.ceil(128 + gap + options.getBoundingClientRect().width + gap + Math.min(sortWidth, 240))
        : Math.ceil(search.getBoundingClientRect().width + sortWidth + gap)
      const wide = Math.ceil(filters.getBoundingClientRect().width + sortWidth + gap)
      // Constructed sheets follow the app's CSP, which disallows inline style elements.
      sheet.replaceSync(`
        [data-scroll-keep]:not([data-scrolling]) { padding-bottom: ${bar}px; }
        @container ${name} (min-width: ${medium}px) {
          .card-grid-controls { grid-template-columns: minmax(0, 1fr) max-content; }
          .card-grid-filter { grid-column: 1 / -1; }
          .card-grid-search { grid-row: 2; grid-column: 1; max-width: 20rem; }
          .card-grid-search[data-with-options] { max-width: none; flex-wrap: nowrap; }
          .card-grid-controls:has(> [data-with-options]) { grid-template-columns: minmax(min-content, 1fr) minmax(0, max-content); }
          .card-grid-sort { grid-row: 2; grid-column: 2; }
        }
        @container ${name} (min-width: ${Math.max(medium, wide)}px) {
          .card-grid-filter { grid-row: 1; grid-column: 1; }
          .card-grid-sort { grid-row: 1; grid-column: 2; }
        }
      `)
    }
    const observer = new ResizeObserver(measure)
    for (const element of [node, filters, sort, search]) observer.observe(element)
    const options = node.querySelector<HTMLElement>("[data-search-options]")
    if (options) observer.observe(options)
    measure()
    return () => {
      observer.disconnect()
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((entry) => entry !== sheet)
    }
  }, [name])
  return (
    <div ref={root} data-card-grid-controls style={{ containerType: "inline-size", containerName: name }}>
      <div aria-hidden="true" className="card-grid-search-size invisible absolute h-0 w-xs" />
      <div className="card-grid-controls grid min-w-0 grid-cols-1 items-start gap-2">
        <div data-scroll-keep className="card-grid-filter min-w-0 overflow-x-auto [&>div]:w-max">
          <CardFilterControl
            archived
            value={browse.filter}
            onChange={(filter) => onChange({ filter })}
            cards={browsable(data)}
            groups={groups}
            withPersonas={browse.withPersonas}
            wrap={false}
            sources={sources?.options ?? []}
            source={shown?.id ?? null}
            {...(onSource ? { onSource } : {})}
          />
        </div>
        <div
          className="card-grid-sort min-w-0 max-w-full justify-self-end"
          data-layout-audit-ignore="inset: Unbordered sort toolbar (its choices scrolling where they don't fit) aligns its controls with the segmented row, rather than enclosing them in a panel"
        >
          {/* Only the sort's choices scroll; the direction and the toggles stay in view, in place. */}
          <div className="flex max-w-full items-start gap-1 [&>button]:mt-[3px]">
            {shown && sources ? (
              <>
                <SourceSortControl browse={sources} scrolls />
                <IncludePersonas
                  browse={browse}
                  onChange={onChange}
                  disabledReason={`Personas are your own cards; ${shown.name} lists characters.`}
                />
                <CardGroupingControl
                  browse={browse}
                  onChange={onChange}
                  disabledReason={`${shown.name} lists each card on its own.`}
                />
              </>
            ) : (
              <>
                <CardSortControl
                  sort={browse.sort}
                  reversed={browse.reversed}
                  onChange={onChange}
                  className="items-start! [&>button]:mt-[3px]"
                  scrolls
                />
                <IncludePersonas browse={browse} onChange={onChange} />
                <CardGroupingControl browse={browse} onChange={onChange} />
              </>
            )}
          </div>
        </div>
        <div
          className={`card-grid-search w-full min-w-0 ${shown && sources && filtersId !== undefined ? "flex flex-wrap items-center gap-2" : ""}`}
          {...(shown && sources && filtersId !== undefined ? { "data-with-options": "" } : {})}
        >
          {shown && sources ? (
            <>
              <Input
                type="search"
                aria-label={`Search ${shown.name}`}
                placeholder={`Search ${shown.name}`}
                value={sources.remote.text}
                onChange={(event) => sources.change({ text: event.currentTarget.value })}
                {...(filtersId !== undefined ? { className: "min-w-32 flex-1 basis-48 @xl:max-w-xs!" } : {})}
              />
              {filtersId !== undefined && <SourceSearchOptions browse={sources} filtersId={filtersId} />}
            </>
          ) : (
            <Input
              type="search"
              aria-label={searchLabel}
              placeholder="Search by name"
              value={search}
              onChange={(event) => onSearch(event.currentTarget.value)}
            />
          )}
        </div>
      </div>
    </div>
  )
}
