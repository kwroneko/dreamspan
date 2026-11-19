// The Files usage line (spec/FILES-AND-ENVIRONMENT.md §1.2, §3.5, §3.6): "1.2 GB of 10 GB used",
// opening a popover with what makes it up (files, earlier versions, the bin, the assistant's
// home folder) and what commands moved over the internet, and Reset the home folder, which
// empties the folder commands keep their installs and settings in (§3.6). Your files stay.
import { useState } from "react"
import { formatByteSize } from "@dreamspan/shared/byteSize.ts"
import type { FilesUsage } from "@dreamspan/shared/filesQuotaApi.ts"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { ConfirmDialog } from "../../ui/Dialog.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { usageLine } from "./usage.ts"

const rows = (usage: FilesUsage) => [
  { label: "Your files", bytes: usage.filesBytes, about: "Everything in your files." },
  {
    label: "Earlier versions",
    bytes: usage.versionsBytes,
    about: "Earlier content kept so changes can be undone or restored. Kept for 30 days."
  },
  { label: "Bin", bytes: usage.binBytes, about: "Files and folders you deleted, until the bin is emptied." },
  {
    label: "Assistant's home folder",
    bytes: usage.homeBytes,
    about: "Where the assistant's commands keep what they install and their settings."
  }
]

export function UsageDetails({ usage, onChanged }: { usage: FilesUsage; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const reset = useAction()
  const line = usageLine(usage)
  return (
    <>
      <Popover
        open={open}
        onOpenChange={setOpen}
        title="Storage"
        triggerLabel={line.text}
        hint={
          usage.over
            ? "Your files are over their storage limit. Delete files you don't need and empty the bin to upload or change files again. Click for details."
            : "How much of your storage your files use. Click for details."
        }
        triggerClassName={`w-fit rounded-md text-sm outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus ${line.warn ? "text-warning" : "text-muted"}`}
        trigger={
          <span data-files-usage="" data-warn={line.warn ? "" : undefined}>
            {line.text}
          </span>
        }
      >
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-sm" data-files-usage-details="">
          {rows(usage).map((row) => (
            <div key={row.label} className="contents" title={row.about}>
              <dt className="min-w-0 text-muted">{row.label}</dt>
              <dd className="text-right tabular-nums">{formatByteSize(row.bytes)}</dd>
            </div>
          ))}
          <div className="contents">
            <dt className="min-w-0 font-medium">Used of {formatByteSize(usage.quotaBytes)}</dt>
            <dd className="text-right font-medium tabular-nums">{formatByteSize(usage.usedBytes)}</dd>
          </div>
        </dl>
        <p className="text-xs text-muted">
          Commands used {formatByteSize(usage.networkBytes)} of internet since{" "}
          {new Date(usage.networkSince).toLocaleDateString()}.
        </p>
        <Button
          variant="ghost"
          className="self-start"
          hint="Empties the assistant's home folder: what its commands installed and their settings. Your files stay."
          onClick={() => setConfirm(true)}
        >
          Reset the home folder
        </Button>
      </Popover>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Reset the assistant's home folder?"
        description="What its commands installed there, such as packages and settings, is removed. Your files stay."
        confirmLabel="Reset"
        confirmHint="Empties the home folder now."
        pending={reset.pending}
        onConfirm={() =>
          void reset
            .run((client) => client("ResetCommandHome", {}))
            .then((result) => {
              if (result.ok) {
                setConfirm(false)
                onChanged()
              }
            })
        }
      >
        <ErrorAlert error={reset.error} title="Not reset" />
      </ConfirmDialog>
    </>
  )
}
