import { Link } from "@tanstack/react-router"
import { useLayoutEffect, useRef, useState } from "react"
import { Icon, type IconName } from "./Icon.tsx"
import { panelToolClass } from "./PanelTabs.tsx"
import { Tooltip } from "./Tooltip.tsx"

/** Route links with the panel tools' appearance, balanced into equal-width columns without hiding any. */
export function NavigationTiles({
  items,
  onNavigate
}: {
  items: ReadonlyArray<{ to: string; label: string; icon: IconName; description: string }>
  onNavigate?: (() => void) | undefined
}) {
  const host = useRef<HTMLDivElement>(null)
  const ruler = useRef<HTMLDivElement>(null)
  const [columns, setColumns] = useState(items.length)
  const labels = items.map((item) => item.label).join("\u0000")
  useLayoutEffect(() => {
    const element = host.current
    const measure = ruler.current
    if (!element || !measure) return
    const read = () => {
      const widths = [...measure.children].map((child) => child.getBoundingClientRect().width)
      const widest = Math.max(...widths)
      // Use the fewest balanced rows whose equal columns fit every label.
      for (let rows = 1; rows <= widths.length; rows++) {
        const count = Math.ceil(widths.length / rows)
        if (widest * count + (count - 1) * 2 <= element.clientWidth) {
          setColumns(count)
          return
        }
      }
    }
    const observer = new ResizeObserver(read)
    observer.observe(element)
    observer.observe(measure)
    read()
    return () => observer.disconnect()
  }, [labels])
  const content = (item: (typeof items)[number]) => (
    <>
      <Icon name={item.icon} className="group-data-[status=active]:text-accent" />
      {item.label}
    </>
  )
  return (
    <div ref={host} className="relative min-w-0">
      <div ref={ruler} aria-hidden="true" className="pointer-events-none invisible absolute flex w-max gap-0.5">
        {items.map((item) => (
          <span key={item.to} className={panelToolClass}>
            {content(item)}
          </span>
        ))}
      </div>
      <div className="grid gap-0.5" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {items.map((item) => (
          <Tooltip key={item.to} label={item.description}>
            <Link
              to={item.to}
              activeOptions={{ exact: item.to === "/", includeSearch: false }}
              onClick={onNavigate}
              className={`group ${panelToolClass} data-[status=active]:border-accent data-[status=active]:text-text`}
            >
              {content(item)}
            </Link>
          </Tooltip>
        ))}
      </div>
    </div>
  )
}
