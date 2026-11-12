// The Context setting's choices (ContextSetting.tsx), apart from the component so it's tested
// without a browser: the chat's view (absent: one shared context), the installed views in their
// order, and a view the chat names that isn't installed, which the server treats as separate.
import type { Cast } from "@rp/shared/chatSetupApi.ts"

/** The built-in default (`assembler/knowledge.ts`): absent state is one shared context. */
const SHARED_VIEW = "shared"

export interface ContextChoice {
  readonly value: string
  readonly label: string
  readonly description?: string
}

export const contextChoices = (
  cast: Pick<Cast, "contextPerSpeaker" | "contextViews">,
  pending: string | null = null
): { readonly value: string; readonly options: ReadonlyArray<ContextChoice> } => {
  const value = pending ?? cast.contextPerSpeaker ?? SHARED_VIEW
  const views = cast.contextViews ?? []
  const installed = views.some((view) => view.id === value)
  return {
    value,
    options: [
      ...(installed || views.length === 0
        ? []
        : [
            {
              value,
              label: `${value} (not installed)`,
              description: "Until it's back, each reply sees only what its speaker was there for."
            }
          ]),
      ...views.map(({ id, label, description }) => ({
        value: id,
        label,
        ...(description === undefined ? {} : { description })
      }))
    ]
  }
}
