// A link's own open menu (owner, 2026-11-23): any control that opens a URL in the app (a link
// button, a menu's link item, a message action's link) carries `linkMenuProps`, and a right-click
// on it shows Open, Open beside and Open in a new browser tab (`LinkMenu.tsx`, mounted once in
// the shell). This holds which link's menu is open, so a menu the link sits in stays open under
// it (`Menu.tsx`).

/** Marks a link (an `a` with `href`, or an element holding one) as having the open menu. */
const LINK_MENU = "data-link-menu"
export const linkMenuProps = { [LINK_MENU]: "" } as const

interface LinkMenuAt {
  readonly x: number
  readonly y: number
  readonly link: HTMLAnchorElement
}

let current: LinkMenuAt | null = null
const listeners = new Set<() => void>()

export const linkMenu = {
  get: () => current,
  set: (next: LinkMenuAt | null) => {
    if (next === current) return
    current = next
    for (const listener of listeners) listener()
  },
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => void listeners.delete(listener)
  }
}

/** The link a right-click on `target` names, when it opens a page of this app. */
export const appLinkAt = (target: EventTarget | null): HTMLAnchorElement | null => {
  const marked = target instanceof Element ? target.closest(`[${LINK_MENU}]`) : null
  if (!marked) return null
  const link = marked instanceof HTMLAnchorElement ? marked : marked.querySelector("a[href]")
  if (!(link instanceof HTMLAnchorElement) || !link.hasAttribute("href")) return null
  if (link.hasAttribute("download") || (link.target && link.target !== "_self")) return null
  const url = new URL(link.href, location.href)
  return url.origin === location.origin ? link : null
}
