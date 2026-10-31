// The end-of-request instruction (DESIGN §2.2, owner 2026-10-29): four texts of the preset,
// outside the prompt order, sent as the request's last message. Fixed: not draggable, not
// deletable, with no condition or generation types.
import { DIRECTION_PROMPT, END_OF_REQUEST } from "@rp/shared/endOfRequest.ts"
import { Card, CardHeader } from "../../ui/Surface.tsx"
import { TextField } from "./controls.tsx"
import type { EditorStore } from "./store.ts"

export function EndOfRequest({ store }: { store: EditorStore }) {
  return (
    <Card>
      <CardHeader
        title="End of request"
        description="Always the last message, after everything above: who writes next, then your direction."
      />
      <div className="flex flex-col gap-4">
        {END_OF_REQUEST.map((text) => (
          <section
            key={text.identifier}
            data-end-of-request={text.identifier}
            className="scroll-mt-[var(--preset-toolbar-height,1rem)] flex flex-col gap-1"
          >
            <TextField
              store={store}
              path={["prompts", `identifier=${text.identifier}`, "content"]}
              label={text.identifier === DIRECTION_PROMPT ? `${text.label} (added after the turn text)` : text.label}
              rows={2}
            />
            <p className="text-xs text-muted">{text.hint}</p>
          </section>
        ))}
      </div>
    </Card>
  )
}
