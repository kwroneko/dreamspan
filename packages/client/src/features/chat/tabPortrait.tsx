// A chat's tab in the workbench's strip shows its first character's face (features/workbench).
import type { CastCard } from "@rp/shared/chat.ts"
import { Avatar } from "../../ui/Avatar.tsx"

export const tabPortrait = (characters: ReadonlyArray<CastCard>) => {
  const first = characters[0]
  if (!first) return undefined
  return {
    key: `${first.entityId}:${first.avatarMediaId ?? ""}:${JSON.stringify(first.avatarCrop ?? null)}`,
    node: (
      <Avatar id={first.entityId} name={first.name} mediaId={first.avatarMediaId} crop={first.avatarCrop} size="xs" />
    )
  }
}
