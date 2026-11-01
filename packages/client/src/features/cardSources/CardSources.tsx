// The card's Sources list, read-only: CCv3 `source` is only appended to, never edited by the
// user (DESIGN §4). Each link opens the site in a new tab.
import { useMemo, useSyncExternalStore } from "react"
import { Icon } from "../../ui/Icon.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { cardSources, sourceRecognizers, type CardSource, type SourceInput } from "./sources.ts"

function SourceRow({ source }: { source: CardSource }) {
  if (source.kind === "id") {
    return (
      <li className="flex flex-col gap-0.5 px-2 py-1.5">
        <span className="text-xs text-muted">Id</span>
        <span className="text-sm text-text [overflow-wrap:anywhere]">{source.id}</span>
      </li>
    )
  }
  return (
    <li>
      <Tooltip label={`Opens ${source.url} on ${source.site} in a new tab`}>
        <a
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
          className="group flex items-start gap-2 rounded-md px-2 py-1.5 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-sm text-text">{source.site}</span>
            <span className="text-xs text-muted [overflow-wrap:anywhere]">{source.label ?? source.url}</span>
          </span>
          <Icon name="external" size={14} className="mt-1 text-muted group-hover:text-accent" />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </Tooltip>
    </li>
  )
}

/** Where the card came from: its archive and site links, then ids no site claimed. */
export function CardSources({ doc }: { doc: SourceInput }) {
  const recognizers = useSyncExternalStore(sourceRecognizers.subscribe, sourceRecognizers.snapshot)
  const sources = useMemo(() => cardSources(doc, recognizers.entries), [doc, recognizers])
  return (
    <section aria-labelledby="card-sources-heading" className="flex flex-col gap-1">
      <h3 id="card-sources-heading" className="text-sm font-medium text-text">
        Sources
      </h3>
      {sources.length === 0 ? (
        <p className="text-sm text-muted">No sources recorded</p>
      ) : (
        <ul className="flex flex-col">
          {sources.map((source) => (
            <SourceRow key={source.kind === "link" ? `link:${source.url}` : `id:${source.id}`} source={source} />
          ))}
        </ul>
      )}
    </section>
  )
}
