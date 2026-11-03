// Shared by the registered home and sidebar character grids. Measure intrinsic controls,
// then let container queries place them without depending on the window or sidebar width.
import { useId, useLayoutEffect, useRef } from "react"
import { Input } from "../../ui/Field.tsx"
import { type CardBrowse, CardFilterControl, CardSortControl, IncludePersonas } from "./cardBrowse.tsx"
import { browsable, type ShellLibrary, useGroupCount } from "./shellData.tsx"

export function CardGridControls({
  data,
  browse,
  onChange,
  search,
  onSearch,
  searchLabel
}: {
  data: ShellLibrary
  browse: CardBrowse
  onChange: (change: Partial<CardBrowse>) => void
  search: string
  onSearch: (search: string) => void
  searchLabel: string
}) {
  const name = `card-grid-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`
  const root = useRef<HTMLDivElement>(null)
  const groups = useGroupCount()
  useLayoutEffect(() => {
    const sheet = new CSSStyleSheet()
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
    const node = root.current!
    const filters = node.querySelector<HTMLElement>(".card-grid-filter > *")!
    const sort = node.querySelector<HTMLElement>(".card-grid-sort > *")!
    const search = node.querySelector<HTMLElement>(".card-grid-search-size")!
    const measure = () => {
      const gap = parseFloat(getComputedStyle(node.querySelector(".card-grid-controls")!).columnGap)
      const sortWidth = sort.getBoundingClientRect().width
      const medium = Math.ceil(search.getBoundingClientRect().width + sortWidth + gap)
      const wide = Math.ceil(filters.getBoundingClientRect().width + sortWidth + gap)
      // Constructed sheets follow the app's CSP, which disallows inline style elements.
      sheet.replaceSync(`
        @container ${name} (min-width: ${medium}px) {
          .card-grid-controls { grid-template-columns: minmax(0, 1fr) max-content; }
          .card-grid-filter { grid-column: 1 / -1; }
          .card-grid-search { grid-row: 2; grid-column: 1; max-width: 20rem; }
          .card-grid-sort { grid-row: 2; grid-column: 2; }
        }
        @container ${name} (min-width: ${Math.max(medium, wide)}px) {
          .card-grid-filter { grid-row: 1; grid-column: 1; }
          .card-grid-sort { grid-row: 1; grid-column: 2; }
        }
      `)
    }
    const observer = new ResizeObserver(measure)
    for (const element of [filters, sort, search]) observer.observe(element)
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
        <div className="card-grid-filter min-w-0 overflow-x-auto">
          <CardFilterControl
            value={browse.filter}
            onChange={(filter) => onChange({ filter })}
            cards={browsable(data)}
            groups={groups}
            withPersonas={browse.withPersonas}
            wrap={false}
          />
        </div>
        <div
          className="card-grid-sort min-w-0 max-w-full justify-self-end overflow-x-auto"
          data-layout-audit-ignore="inset: Unbordered scrolling sort toolbar aligns its controls with the segmented row, rather than enclosing them in a panel"
        >
          <div className="flex w-max items-start gap-1 [&>button]:mt-[3px]">
            <CardSortControl
              sort={browse.sort}
              reversed={browse.reversed}
              onChange={onChange}
              className="items-start! [&>button]:mt-[3px]"
            />
            <IncludePersonas browse={browse} onChange={onChange} />
          </div>
        </div>
        <div className="card-grid-search w-full min-w-0">
          <Input
            type="search"
            aria-label={searchLabel}
            placeholder="Search by name"
            value={search}
            onChange={(event) => onSearch(event.currentTarget.value)}
          />
        </div>
      </div>
    </div>
  )
}
