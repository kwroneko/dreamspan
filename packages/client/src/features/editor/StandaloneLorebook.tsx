import { Tooltip } from "../../ui/Tooltip.tsx"
import type { LorebookPreset } from "@rp/shared/chatSetupApi.ts"
import type { LorebookDoc } from "@rp/shared/docs/lorebook.ts"
import { Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { Card } from "../../ui/Surface.tsx"
import type { Caller } from "./caller.ts"
import { LorebookForm } from "./LorebookForm.tsx"
import { type EditorStore, useEditorState, useValue } from "./store.ts"

const BOOK: ReadonlyArray<string> = []

const count = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/**
 * Registered standalone lorebook section: how many entries it has, and the prompt presets that
 * send it (as saved), each a link to its editor. The chats it was added to are the editor's
 * header line.
 */
export function LorebookUse({ store, call }: { store: EditorStore; call: Caller }) {
  const entries = useValue<LorebookDoc | undefined>(store, BOOK)?.entries.length ?? 0
  const revision = useEditorState(store).snapshot?.ref.headRevisionId
  const [presets, setPresets] = useState<ReadonlyArray<LorebookPreset> | null>(null)
  useEffect(() => {
    let live = true
    void call((client) => client("LorebookPresets", { ref: store.refId })).then(
      (result) => live && result.ok && setPresets(result.value)
    )
    return () => {
      live = false
    }
  }, [call, store.refId, revision])
  return (
    <section aria-label="Where it's used" className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
      <p className="shrink-0 text-sm font-semibold">{count(entries, "entry", "entries")}</p>
      {presets !== null && presets.length > 0 && (
        <p className="text-sm text-muted">
          Sent with the prompt {presets.length === 1 ? "preset" : "presets"}{" "}
          {presets.map((preset, index) => (
            <span key={preset.refId}>
              {index > 0 && ", "}
              <Tooltip label="Opens the preset using this lorebook.">
                <Link
                  to="/library/$refId"
                  params={{ refId: preset.refId }}
                  className="text-accent underline-offset-4 hover:underline"
                >
                  {preset.label}
                </Link>
              </Tooltip>
              {!preset.enabled && " (switched off there)"}
            </span>
          ))}
          , in every chat using {presets.length === 1 ? "it" : "them"}.
        </p>
      )}
    </section>
  )
}

/** Registered standalone lorebook section: the book's settings and its entries, as field drafts. */
export function StandaloneLorebook({ store }: { store: EditorStore }) {
  return (
    <Card>
      <LorebookForm store={store} root={BOOK} absent="This lorebook is empty." />
    </Card>
  )
}
