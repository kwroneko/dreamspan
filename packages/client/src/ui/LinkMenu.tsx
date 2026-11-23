// The open menu of the app's links (owner, 2026-11-23): a right-click (or the keyboard's menu
// key) on a control marked with `linkMenuProps` shows the same items as a chat row's menu: Open
// (what a click does), Open beside where frames fit side by side, and Open in a new browser tab.
// One listener for the page, so every link that declares itself gets it, in a menu or not.
import { useEffect, useRef, useSyncExternalStore } from "react"
import { MenuItem, PointMenu } from "./Menu.tsx"
import { appLinkAt, linkMenu } from "./linkMenuState.ts"
import { OPEN_BESIDE_HINT, OPEN_HERE_HINT, OPEN_NEW_TAB_HINT, openBeside, useCanOpenBeside } from "./openBeside.ts"

/** Mounted once in the shell. */
export function LinkMenu() {
  const at = useSyncExternalStore(linkMenu.subscribe, linkMenu.get)
  const beside = useCanOpenBeside()
  // An item chosen: focus stays with what it opened (another frame), not back on the link.
  const chosen = useRef(false)
  useEffect(() => {
    const open = (event: MouseEvent) => {
      // A menu of the control's own (a chat row's) answered already.
      if (event.defaultPrevented) return
      const link = appLinkAt(event.target)
      if (link === null) return
      chosen.current = false
      event.preventDefault()
      // The keyboard's menu key has no pointer: under the link.
      const keyboard = event.clientX === 0 && event.clientY === 0
      const rect = link.getBoundingClientRect()
      linkMenu.set({ x: keyboard ? rect.left : event.clientX, y: keyboard ? rect.bottom : event.clientY, link })
    }
    document.addEventListener("contextmenu", open)
    return () => document.removeEventListener("contextmenu", open)
  }, [])
  const link = at?.link ?? null
  const href = link?.getAttribute("href") ?? null
  const close = () => linkMenu.set(null)
  const choose = () => {
    chosen.current = true
    close()
  }
  return (
    <PointMenu
      at={at}
      onClose={close}
      finalFocus={() => !chosen.current}
      label={`Actions for ${(link?.getAttribute("aria-label") ?? link?.textContent ?? "").trim()}`}
    >
      {link !== null && href !== null && (
        <>
          <MenuItem
            description={OPEN_HERE_HINT}
            onClick={() => {
              choose()
              // The link's own click: whatever opening it does here.
              link.click()
            }}
          >
            Open
          </MenuItem>
          {beside && (
            <MenuItem
              icon="split-right"
              description={OPEN_BESIDE_HINT}
              onClick={() => {
                choose()
                openBeside(href)
              }}
            >
              Open beside
            </MenuItem>
          )}
          <MenuItem
            icon="external"
            description={OPEN_NEW_TAB_HINT}
            onClick={() => {
              choose()
              window.open(link.href, "_blank", "noopener")
            }}
          >
            Open in a new browser tab
          </MenuItem>
        </>
      )}
    </PointMenu>
  )
}
