import { accessSync, constants, mkdirSync, statSync } from "node:fs"
import { join, parse, resolve, sep } from "node:path"
import { Effect, Schema } from "effect"

class DataDirectoryUnusable extends Schema.TaggedError<DataDirectoryUnusable>()("DataDirectoryUnusable", {
  dataDir: Schema.String,
  reason: Schema.String
}) {
  override get message() {
    return `Cannot use DATA_DIR ${this.dataDir}: ${this.reason}`
  }
}

export const prepareDataDirectory = (dataDir: string) =>
  Effect.try({
    try: () => {
      const absolute = resolve(dataDir)
      let directory = parse(absolute).root
      // Node's recursive mkdir loops on ENOENT from /proc/nope. Each component is
      // attempted once here, so a filesystem that refuses creation fails immediately.
      for (const component of absolute.slice(directory.length).split(sep).filter(Boolean)) {
        directory = join(directory, component)
        try {
          mkdirSync(directory)
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause
          if (!statSync(directory).isDirectory()) throw new Error(`${directory} is not a directory`)
        }
      }
      accessSync(absolute, constants.W_OK | constants.X_OK)
    },
    catch: (cause) => new DataDirectoryUnusable({ dataDir, reason: String(cause) })
  })
