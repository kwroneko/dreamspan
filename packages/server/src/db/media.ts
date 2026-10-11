// Media files (DATA-MODEL §11): content-addressed under the data directory, recorded in
// media_assets and reachable by a user only through their media_refs.

/** Where the file with this SHA-256 lives, relative to the data directory. */
export const mediaPath = (sha256: string) => `media/${sha256.slice(0, 2)}/${sha256}`
