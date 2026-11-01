// A place to drop files that is also a file picker: a label around a visually hidden file
// input, so a click, Enter or Space opens the picker, and screen readers announce the label.
// With `directory`, it picks a folder, and each file keeps its path in the folder
// (`webkitRelativePath`); a dropped folder has no paths, so dropping is off.
import { type DragEvent, type ReactNode, useState } from "react"

export function FileDrop({
  label,
  description,
  multiple = false,
  accept,
  disabled = false,
  directory = false,
  onFiles
}: {
  label: ReactNode
  description?: ReactNode
  multiple?: boolean
  accept?: string
  disabled?: boolean
  directory?: boolean
  onFiles: (files: ReadonlyArray<File>) => void
}) {
  const [over, setOver] = useState(false)
  const drop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault()
    setOver(false)
    if (disabled || directory) return
    const files = [...event.dataTransfer.files]
    onFiles(multiple ? files : files.slice(0, 1))
  }
  return (
    <label
      onDragOver={(event) => {
        event.preventDefault()
        if (!disabled && !directory) setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
      data-over={over || undefined}
      data-disabled={disabled || undefined}
      className="flex cursor-pointer flex-col items-center gap-1 rounded-lg border-2 border-dashed border-border bg-surface px-4 py-8 text-center transition-colors has-[:focus-visible]:border-focus has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus/40 hover:bg-surface-raised data-disabled:cursor-default data-disabled:opacity-50 data-over:border-accent data-over:bg-surface-raised"
    >
      <input
        type="file"
        className="sr-only"
        multiple={multiple || directory}
        accept={accept}
        // React passes it through as the attribute; TypeScript's DOM types don't list it.
        {...(directory ? { webkitdirectory: "" } : {})}
        disabled={disabled}
        onChange={(event) => {
          onFiles([...(event.currentTarget.files ?? [])])
          // The same file can be picked again.
          event.currentTarget.value = ""
        }}
      />
      <span className="text-sm font-medium">{label}</span>
      {description && <span className="text-sm text-muted">{description}</span>}
    </label>
  )
}
