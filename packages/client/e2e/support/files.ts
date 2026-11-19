// Seeding and checking an account's Files from a browser test, over the server's own file routes
// (`@dreamspan/shared/files.ts` FILES_ROUTES), as the logged-in request context. Synthetic files only.
import type { APIRequestContext } from "@playwright/test"
import { FILES_ROUTES, FILES_TOP, joinPath, type FolderListing } from "@dreamspan/shared/files.ts"

/** A one-pixel PNG. */
export const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
)

export const filesOf = (request: APIRequestContext, url: string) => {
  const headers = { origin: url }
  const list = async (path: string) => {
    const response = await request.get(`${url}${FILES_ROUTES.list}?${new URLSearchParams({ path })}`, { headers })
    if (!response.ok()) throw new Error(`listing ${path}: ${response.status()} ${await response.text()}`)
    return (await response.json()) as FolderListing
  }
  return {
    list,
    /** Empties the account's Files. */
    clear: async () => {
      for (const entry of (await list(FILES_TOP)).entries)
        await request.post(`${url}${FILES_ROUTES.delete}`, { headers, data: { path: joinPath(FILES_TOP, entry.name) } })
    },
    put: async (path: string, content: string | Buffer) => {
      const response = await request.post(
        `${url}${FILES_ROUTES.upload}?${new URLSearchParams({ path, conflict: "replace" })}`,
        {
          headers: { ...headers, "content-type": "application/octet-stream" },
          data: Buffer.from(content)
        }
      )
      if (!response.ok()) throw new Error(`uploading ${path}: ${response.status()} ${await response.text()}`)
    },
    /** The file's text, or null when it isn't there. */
    text: async (path: string) => {
      const response = await request.get(`${url}${FILES_ROUTES.raw}?${new URLSearchParams({ path })}`, { headers })
      return response.ok() ? response.text() : null
    },
    has: async (path: string) => {
      const parent = path.slice(0, path.lastIndexOf("/")) || FILES_TOP
      const name = path.slice(path.lastIndexOf("/") + 1)
      const listing = await list(parent).catch(() => null)
      return listing?.entries.some((entry) => entry.name === name) ?? false
    }
  }
}
