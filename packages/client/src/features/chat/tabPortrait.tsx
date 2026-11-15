// A chat's tab in the workbench's strip shows the chat's own picture, else its first
// character's face (features/workbench).
import type { CastCard } from "@rp/shared/chat.ts"
import { Avatar } from "../../ui/Avatar.tsx"

export const tabPortrait = (
  characters: ReadonlyArray<CastCard>,
  picture?: { readonly id: string; readonly name: string; readonly mediaId: string } | null
) => {
  if (picture)
    return {
      key: `picture:${picture.mediaId}`,
      node: <Avatar id={picture.id} name={picture.name} mediaId={picture.mediaId} size="xs" />
    }
  const first = characters[0]
  if (!first) return undefined
  return {
    key: `${first.entityId}:${first.avatarMediaId ?? ""}:${JSON.stringify(first.avatarCrop ?? null)}`,
    node: (
      <Avatar id={first.entityId} name={first.name} mediaId={first.avatarMediaId} crop={first.avatarCrop} size="xs" />
    )
  }
}
