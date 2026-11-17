// The Files page's address (spec/FILES-AND-ENVIRONMENT.md §8.1; memory: URL is truth): the folder
// shown and the file open in it. `/files` itself, with the place in its search, since the server's
// file routes (`/files/raw`, `/files/upload`) share that prefix and a folder named "raw" must
// never be taken for one.
import { FILES_TOP, normalizePath } from "@rp/shared/files.ts"

export const FILES_PAGE = "/files"

export const filesHref = (folder: string, file: string | null = null) => {
  const params = new URLSearchParams()
  const path = normalizePath(folder)
  if (path !== FILES_TOP) params.set("path", path)
  if (file !== null) params.set("file", file)
  const query = params.toString()
  return query ? `${FILES_PAGE}?${query}` : FILES_PAGE
}
