// Media files (DATA-MODEL §11): content-addressed under the data directory, recorded in
// media_assets and reachable by a user only through their media_refs.

/** Where the file with this SHA-256 lives, relative to the data directory. */
export const mediaPath = (sha256: string) => `media/${sha256.slice(0, 2)}/${sha256}`

/** Whether a stored path is one `mediaPath` makes, so it can't name a file anywhere else. */
export const isMediaPath = (path: string) => /^media\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(path)

/** Whether a path is a card source's cached image (`sources/cache.ts`), which thumbnails are made from too. */
export const isSourceCachePath = (path: string) => /^cache\/sources\/blobs\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(path)
