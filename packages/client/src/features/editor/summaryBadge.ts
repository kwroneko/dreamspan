import type { PresetContext } from "@rp/shared/inspectorApi.ts"

/** What `{{summary}}` fills in for the chat in context: ST's summary note, never the summaries (DESIGN §8). */
export const summaryBadge = (fill: NonNullable<PresetContext["summary"]>) =>
  fill.kind === "notes"
    ? `{{summary}}: ${fill.titles.length === 1 ? `${fill.titles[0]} note` : `${fill.count} summary notes`} (~${fill.tokens.toLocaleString()} tokens)`
    : "{{summary}}: Nothing, no summary note is on"
