// The model a separate counting connection is asked for (owner, 2026-11-02: "It should also be
// possible to specify a separate token counting endpoint for a connection"). A chat's model on
// one connection (OpenRouter's `anthropic/claude-sonnet-4.5`) is named otherwise on the one
// that counts (Anthropic's `claude-sonnet-4-5`): its own key if the counting connection lists
// it, else the key without a router's `vendor/` prefix, matched against that connection's
// models with dots and dashes alike, else the bare key as it is.

const bare = (key: string) => key.replace(/^models\//, "").replace(/^[^/]+\//, "")
const loose = (key: string) => bare(key).toLowerCase().replace(/[.:_]/g, "-")

export const countingModelKey = (modelKey: string, listed: ReadonlyArray<string>): string => {
  if (listed.includes(modelKey)) return modelKey
  const name = bare(modelKey)
  if (listed.includes(name)) return name
  const wanted = loose(modelKey)
  return listed.find((key) => loose(key) === wanted) ?? name
}
