// "Export…" in a card's editor (owner, 2026-11-01: before, export was only in the library's
// item menu): the full editor's header and the chat's character and persona tabs. The formats
// are the exporters the server registers for cards (`ListExportFormats`), so a plugin's format
// shows here too; the trigger's tooltip names them. A file is always a saved revision: with
// unsaved changes, the export asks first (`requestExport`, owner 2026-11-02).
import { useAtomValue } from "@effect/atom-react"
import type { RefId } from "@rp/shared/library.ts"
import { AsyncResult } from "effect/reactivity"
import { AppClient } from "../../rpc.ts"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Menu, MenuItem } from "../../ui/Menu.tsx"
import { requestExport } from "./exportRequests.ts"

const formatsAtom = AppClient.query("ListExportFormats", undefined, { reactivityKeys: ["library"] })

export function CardExport({ refId, label, compact = false }: { refId: RefId; label: string; compact?: boolean }) {
  const result = useAtomValue(formatsAtom)
  const formats = AsyncResult.isSuccess(result) ? result.value.filter((format) => format.kind === "card") : []
  if (formats.length === 0) return null
  const names = formats.map((format) => format.label).join(", ")
  return (
    <Menu
      label={`Export ${label} as`}
      hint={`Downloads the card's last saved revision as a file: ${names}. With unsaved changes, it asks first.`}
      trigger={
        <Button variant={compact ? "ghost" : "secondary"} className={compact ? "h-8! px-2!" : ""}>
          Export…
          <Icon name="down" />
        </Button>
      }
    >
      {formats.map((format) => (
        <MenuItem
          key={format.id}
          description={format.description}
          onClick={() => requestExport({ refId, format: format.id, formatLabel: format.label, label })}
        >
          {format.label}
        </MenuItem>
      ))}
    </Menu>
  )
}
