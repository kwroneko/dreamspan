// "Export…" in a card's editor (owner, 2026-11-01: before, export was only in the library's
// item menu): the full editor's header and the chat's character tab. The formats are the
// exporters the server registers for cards (`ListExportFormats`), so a plugin's format shows
// here too; the trigger's tooltip names them.
import { useAtomValue } from "@effect/atom-react"
import type { RefId } from "@rp/shared/library.ts"
import { AsyncResult } from "effect/reactivity"
import { AppClient } from "../../rpc.ts"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Menu, MenuItem } from "../../ui/Menu.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { downloadExport } from "../library/files.ts"

const formatsAtom = AppClient.query("ListExportFormats", undefined, { reactivityKeys: ["library"] })

/** Edits not yet in a revision are in the live text: the export is the card's latest revision. */
export function CardExport({ refId, label, compact = false }: { refId: RefId; label: string; compact?: boolean }) {
  const result = useAtomValue(formatsAtom)
  const formats = AsyncResult.isSuccess(result) ? result.value.filter((format) => format.kind === "card") : []
  if (formats.length === 0) return null
  const names = formats.map((format) => format.label).join(", ")
  const exportAs = async (format: string) => {
    const error = await downloadExport(refId, format, label)
    if (error) showToast({ title: `Couldn’t export ${label}`, description: error })
  }
  return (
    <Menu
      label={`Export ${label} as`}
      hint={`Downloads the card's last saved revision as a file: ${names}.`}
      trigger={
        <Button variant={compact ? "ghost" : "secondary"} className={compact ? "h-8! px-2!" : ""}>
          Export…
          <Icon name="down" />
        </Button>
      }
    >
      {formats.map((format) => (
        <MenuItem key={format.id} description={format.description} onClick={() => void exportAs(format.id)}>
          {format.label}
        </MenuItem>
      ))}
    </Menu>
  )
}
