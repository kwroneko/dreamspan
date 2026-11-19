// A group's members as one picture: two side by side, three as two above one centred (every
// face whole, the same size, and no empty slot), four or more in a 2×2 grid with "+N" on the
// last for the rest.
import type { ChatGroup } from "@dreamspan/shared/chatSetupApi.ts"
import { Avatar } from "../../ui/Avatar.tsx"

export function GroupFaces({ members }: { members: ChatGroup["members"] }) {
  const shown = members.slice(0, 4)
  const more = members.length - shown.length
  return (
    <span aria-hidden="true" className="grid size-full grid-cols-2 content-center gap-1 bg-surface-raised p-2">
      {shown.map((member, i) => (
        <span
          key={member.entityId}
          className={`relative min-w-0 ${shown.length === 3 && i === 2 ? "col-span-2 w-[calc(50%-0.125rem)] justify-self-center" : ""}`}
        >
          <Avatar
            id={member.entityId}
            name={member.name}
            mediaId={member.avatarMediaId}
            crop={member.avatarCrop}
            size="fill"
          />
          {more > 0 && i === shown.length - 1 && (
            <span
              data-layout-overlay="Remaining-member count covers the last group portrait"
              title={members
                .slice(shown.length)
                .map((member) => member.name)
                .join(", ")}
              className="absolute inset-0 flex items-center justify-center rounded-sm bg-surface-raised/70 text-lg font-semibold text-muted"
            >
              +{more}
            </span>
          )}
        </span>
      ))}
    </span>
  )
}
