// A message's attached image in the image column (owner, 2026-11-07): its id brings back its
// media and name after a reload, and an image without a file name is named for its speaker.
import { describe, expect, it } from "vitest"
import { attachmentName, attachmentOf, attachmentPicture } from "../src/features/chat/attachmentPictures.ts"

describe("attached images as pictures", () => {
  it("keeps a file name and names a pasted image for its speaker", () => {
    expect(attachmentName("costume.png", "Mira", 0, 1)).toBe("costume.png")
    expect(attachmentName("Pasted image", "Mira", 0, 1)).toBe("Image from Mira")
    expect(attachmentName(undefined, "you", 1, 3)).toBe("Image 2 from you")
    expect(attachmentName("  ", null, 2, 3)).toBe("Image 3")
    expect(attachmentName("Restored image", null, 0, 1)).toBe("Image")
  })

  it("reads its media and name back from its id, and nothing from another picture's", () => {
    const picture = attachmentPicture("0f3a-media", "Image 2 from Mira: a study")
    expect(attachmentOf(picture.id)).toEqual(picture)
    expect(attachmentOf("gallery:0f3a:uri")).toBeNull()
    expect(attachmentOf("6d1f0c3e-0000-4000-8000-000000000000")).toBeNull()
    expect(attachmentOf("image:media:%E0%A4%A")).toBeNull()
  })
})
