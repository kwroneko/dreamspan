/** Host-created signal: evaluation engines must not turn a failed plugin into ordinary text. */
export class PluginFault extends Error {
  readonly _tag = "PluginFault"
  constructor(id: string) {
    super(`rp-plugin-fault:${id}`)
  }
}
