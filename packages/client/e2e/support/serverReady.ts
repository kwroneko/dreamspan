// Imported for its URL by the parent; preloaded only in the child it launches.
import { Server } from "node:net"

export const serverReadyModule = import.meta.url

if (process.execArgv.includes(serverReadyModule)) {
  const emit = Server.prototype.emit as (this: Server, event: string | symbol, ...args: unknown[]) => boolean
  Server.prototype.emit = function (this: Server, event: string | symbol, ...args: unknown[]) {
    if (event === "listening") {
      const address = this.address()
      if (address && typeof address === "object" && address.port === Number(process.env.PORT))
        process.send?.({ _tag: "BrowserServerListening", port: address.port })
    }
    return emit.call(this, event, ...args)
  }
}
