// The server's Content-Security-Policy allows no inline <style> (server.ts). Base UI's
// Select and ScrollArea would add one to hide native scrollbars: they don't, and
// styles.css carries the rule they'd have added (`.base-ui-disable-scrollbar`).
import { CSPProvider } from "@base-ui/react/csp-provider"
import type { ReactNode } from "react"

export function CspProvider({ children }: { children: ReactNode }) {
  return <CSPProvider disableStyleElements>{children}</CSPProvider>
}
