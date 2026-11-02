// How chats imported from ST are named: synthetic titles only.
import { describe, expect, it } from "vitest"
import { chatName, renamedTitle } from "../src/chatName.ts"

const cast = [{ name: "Cleo" }]

describe("chat names", () => {
  it("reads ST's stamps, the current one and the older one with spaces", () => {
    expect(chatName("Cleo - 2026-05-11@07h51m55s691ms", [])).toEqual({
      name: "Cleo",
      started: new Date(Date.UTC(2026, 4, 11, 7, 51, 55))
    })
    // ST before late 2024: unpadded, with spaces. A bare stamp is named by its cast.
    expect(chatName("2024-9-10 @13h 44m 41s 16ms", cast)).toEqual({
      name: "Cleo",
      started: new Date(Date.UTC(2024, 8, 10, 13, 44, 41))
    })
    expect(chatName("Party: 2024-9-10 @13h 44m 41s 16ms", cast).name).toBe("Party")
  })

  it("dates an imported chat by when it started, given that, never by a stale file name", () => {
    const started = Date.UTC(2026, 3, 20, 6, 36)
    expect(chatName("2024-9-10 @13h 44m 41s 16ms", cast, started)).toEqual({ name: "Cleo", started: new Date(started) })
    // A chat made here has no ST start to show.
    expect(chatName("The inn", cast, started)).toEqual({ name: "The inn", started: null })
  })

  it("keeps the older stamp when the chat is renamed", () => {
    expect(renamedTitle("2024-9-10 @13h 44m 41s 16ms", "The inn")).toBe("The inn - 2024-9-10 @13h 44m 41s 16ms")
  })
})
