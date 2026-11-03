// Which files of an ST folder the importer reads (stFolder.ts), and finding the user folders
// in what was picked.
import { describe, expect, it } from "vitest"
import { classifyStPath, findStRoots } from "../src/stFolder.ts"

describe("ST folder paths", () => {
  it("names the files the import reads", () => {
    expect(classifyStPath("settings.json")).toEqual({ kind: "settings" })
    expect(classifyStPath("User Avatars/me.webp")).toEqual({ kind: "persona_avatar", file: "me.webp" })
    expect(classifyStPath("characters/Alice.png")).toEqual({ kind: "card", file: "Alice.png" })
    expect(classifyStPath("worlds/Hollow.json")).toEqual({ kind: "world", name: "Hollow" })
    expect(classifyStPath("OpenAI Settings/Default.json")).toEqual({ kind: "preset", name: "Default" })
    expect(classifyStPath("groups/1.json")).toEqual({ kind: "group", file: "1.json" })
    expect(classifyStPath("chats/Alice/Alice - 1.jsonl")).toEqual({ kind: "chat", folder: "Alice", name: "Alice - 1" })
    expect(classifyStPath("group chats/1.jsonl")).toEqual({ kind: "group_chat", name: "1" })
    expect(classifyStPath("instruct/Alpaca.json")).toEqual({ kind: "unsupported", what: "instruct template" })
  })

  it("reads nothing else: secrets, backups, images, and paths that could leave the folder", () => {
    for (const path of [
      "secrets.json",
      "backups/chat_a.jsonl",
      "thumbnails/avatar/a.png",
      "user/images/a.png",
      "characters/sub/a.png",
      "chats/../settings.json",
      "chats/a/../../x.jsonl",
      "../settings.json",
      "/settings.json",
      "chats/a\\b/c.jsonl",
      "chats/a/b\u0000.jsonl",
      "characters/C:x.png",
      `characters/${"a".repeat(300)}.png`
    ]) {
      expect(classifyStPath(path), path).toBeNull()
    }
  })

  it("finds each user's folder in ST's multi-user layout, wherever the pick started", () => {
    const paths = [
      "ST/data/default-user/settings.json",
      "ST/data/default-user/chats/A/a.jsonl",
      "ST/data/default-user/backups/x.jsonl",
      "ST/data/bea/characters/B.png",
      "ST/config.yaml"
    ]
    expect(findStRoots(paths)).toEqual([
      { prefix: "ST/data/bea/", name: "bea", files: 1 },
      { prefix: "ST/data/default-user/", name: "default-user", files: 2 }
    ])
    expect(findStRoots(["characters/A.png", "settings.json"])).toEqual([{ prefix: "", name: "", files: 2 }])
  })
})

it("recognizes per-card gallery image folders without accepting other files", () => {
  expect(classifyStPath("user/images/Mira/sunset.png")).toEqual({ kind: "gallery", folder: "Mira", file: "sunset.png" })
  expect(classifyStPath("user/images/Mira/run.js")).toBeNull()
  expect(classifyStPath("user/images/../photo.png")).toBeNull()
})
