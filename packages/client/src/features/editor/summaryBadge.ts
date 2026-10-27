import type { PresetContext } from "@rp/shared/inspectorApi.ts"

/** What `{{summary}}` fills in for the chat in context (DESIGN §8 [P]). */
export const summaryBadge = (fill: NonNullable<PresetContext["summary"]>) =>
  fill.kind === "summaries"
    ? `{{summary}}: Summaries (${fill.count}, ~${fill.tokens.toLocaleString()} tokens)`
    : fill.kind === "notes"
      ? `{{summary}}: ${fill.titles.length === 1 ? `${fill.titles[0]} note` : `${fill.count} summary notes`} (~${fill.tokens.toLocaleString()} tokens)`
      : "{{summary}}: Nothing, no summary note is on"
