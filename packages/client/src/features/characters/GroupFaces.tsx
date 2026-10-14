// A group's members as one picture, as ST's group tiles show them: two side by side, three
// as one tall and two stacked, four or more in a 2×2 grid with "+N" on the last for the rest.
import type { ChatGroup } from "@rp/shared/chatSetupApi.ts"
import { Avatar } from "../../ui/Avatar.tsx"

export function GroupFaces({ members }: { members: ChatGroup["members"] }) {
  const shown = members.slice(0, 4)
  const more = members.length - shown.length
  return (
    <span
      aria-hidden="true"
      className={`grid size-full gap-px bg-border ${shown.length === 2 ? "grid-cols-2 grid-rows-1" : "grid-cols-2 grid-rows-2"}`}
    >
      {shown.map((member, i) => (
        <span
          key={member.entityId}
          className={`relative min-h-0 overflow-hidden ${shown.length === 3 && i === 0 ? "row-span-2" : ""}`}
        >
          <Avatar
            id={member.entityId}
            name={member.name}
            mediaId={member.avatarMediaId}
            size="fill"
            shape="square"
            className="object-[50%_20%]"
          />
          {more > 0 && i === shown.length - 1 && (
            <span className="absolute inset-0 flex items-center justify-center bg-canvas/70 text-lg font-semibold text-text">
              +{more}
            </span>
          )}
        </span>
      ))}
    </span>
  )
}
