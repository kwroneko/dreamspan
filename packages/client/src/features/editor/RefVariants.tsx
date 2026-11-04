import { Link } from "@tanstack/react-router"
import { type EditorStore, useEditorState } from "./store.ts"

/** The full editor's variant navigation, shared with the compact lorebook editor. */
export function RefVariants({ store }: { store: EditorStore }) {
  const snapshot = useEditorState(store).snapshot
  if (!snapshot || snapshot.ref.kind === "card" || snapshot.variants.length <= 1) return null
  const { ref, variants } = snapshot
  return (
    <nav aria-label="Variants" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span className="text-muted">Variants:</span>
      {variants.map((variant) =>
        variant.id === ref.id ? (
          <span key={variant.id} aria-current="page" className="font-medium">
            {variant.label}
            {ref.kind !== "card" && variant.subtitle ? ` · ${variant.subtitle}` : ""}
          </span>
        ) : (
          <Link
            key={variant.id}
            to="/library/$refId"
            params={{ refId: variant.id }}
            className="text-accent underline-offset-4 hover:underline"
          >
            {variant.label}
            {ref.kind !== "card" && variant.subtitle ? ` · ${variant.subtitle}` : ""}
          </Link>
        )
      )}
    </nav>
  )
}
