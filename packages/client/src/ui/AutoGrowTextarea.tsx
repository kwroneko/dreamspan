import { type ComponentProps, useCallback, useEffect, useLayoutEffect, useRef } from "react"

/** The composer's box: one line when empty, growing with its text up to a third of the screen. */
export function AutoGrowTextarea(props: ComponentProps<"textarea"> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const fit = useCallback(() => {
    const box = ref.current
    if (box === null) return
    box.style.height = "auto"
    box.style.height = `${Math.min(box.scrollHeight, Math.max(160, innerHeight / 3))}px`
  }, [])
  useLayoutEffect(fit, [fit, props.value, props.placeholder])
  // The same text takes more lines in a narrower box: a phone turned, a panel opened.
  useEffect(() => {
    const box = ref.current
    if (box === null || typeof ResizeObserver === "undefined") return
    let width = box.clientWidth
    const observer = new ResizeObserver(() => {
      if (box.clientWidth === width) return
      width = box.clientWidth
      fit()
    })
    observer.observe(box)
    return () => observer.disconnect()
  }, [fit])
  return (
    <textarea
      ref={ref}
      rows={1}
      {...props}
      className="max-h-[33vh] min-h-9 min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-base text-text outline-none placeholder:text-muted sm:text-sm"
    />
  )
}
