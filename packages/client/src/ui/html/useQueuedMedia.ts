import { useEffect, useReducer } from "react"
import { mediaQueue as queue, PENDING_MEDIA as PENDING, mapCssMedia, mapMediaAttribute } from "./mediaQueue.ts"

function useQueuedMedia(urls: ReadonlyArray<string>): (url: string) => string {
  const [, refresh] = useReducer((n: number) => n + 1, 0)
  const key = JSON.stringify([...new Set(urls)].sort())
  useEffect(() => {
    const releases = (JSON.parse(key) as string[]).map((url) => queue.retain(url, refresh))
    refresh()
    return () => releases.forEach((release) => release())
  }, [key])
  return (url) => (typeof window === "undefined" ? url : (queue.read(url) ?? PENDING))
}

/** Only resource-bearing attributes participate, never links or source-copy metadata. */
export function useQueuedMediaProps(props: Record<string, unknown>, tag: string): Record<string, unknown> {
  tag = tag.toLowerCase()
  const keys = [
    ...(["img", "input", "audio", "source"].includes(tag) ? ["src"] : []),
    ...(tag === "img" ? ["srcSet"] : []),
    ...(["body", "table", "td", "th"].includes(tag) ? ["background"] : []),
    ...(["image", "feimage"].includes(tag) ? ["href", "xlinkHref", "xLinkHref"] : [])
  ]
  const style = props.style as Record<string, unknown> | undefined
  const attributes = keys.filter((key) => typeof props[key] === "string")
  const styles =
    style && typeof style === "object" ? Object.keys(style).filter((key) => typeof style[key] === "string") : []
  const urls: string[] = []
  for (const key of attributes)
    mapMediaAttribute(props[key] as string, key === "srcSet", (url) => {
      urls.push(url)
      return url
    })
  for (const key of styles)
    mapCssMedia(style![key] as string, (url) => {
      urls.push(url)
      return url
    })
  const resolve = useQueuedMedia(urls)
  return {
    ...props,
    ...Object.fromEntries(
      attributes.map((key) => [key, mapMediaAttribute(props[key] as string, key === "srcSet", resolve)])
    ),
    ...(styles.length
      ? {
          style: {
            ...style,
            ...Object.fromEntries(styles.map((key) => [key, mapCssMedia(style![key] as string, resolve)]))
          }
        }
      : {})
  }
}
