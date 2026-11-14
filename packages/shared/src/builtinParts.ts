// Only complete, typed adapters may replace built-ins through stable plugin handles.
const parts: Readonly<Record<string, { side: "client" | "server" | "worker"; label: string }>> = {
  "noticeChannels:notifications.completion-sound": { side: "client", label: "Completion sound" },
  "rolloutTools:set_presence": { side: "server", label: "Who's present (set_presence)" },
  "macros:reverse": { side: "worker", label: "Reverse text macro (reverse)" }
}
export const builtinReplacement = (key: string) => (Object.hasOwn(parts, key) ? parts[key] : undefined)
