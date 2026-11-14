// Shipped-source allowlist. Never interpret a manifest's base.path as a filesystem path.
export const builtinCopies = [
  {
    registry: "noticeChannels",
    id: "notifications.completion-sound",
    label: "Completion sound",
    side: "client",
    path: "packages/client/src/features/completionSoundPart.tsx",
    entry: "completionSound",
    files: ["packages/client/src/features/completionSoundPart.tsx", "packages/client/src/features/completionSound.ts"],
    surfaces: ["client:noticeChannels"],
    imports: {
      "packages/client/src/ui/Choice.tsx": "@rp/plugin-api/client",
      "packages/client/src/ui/Surface.tsx": "@rp/plugin-api/client"
    }
  },
  {
    registry: "rolloutTools",
    id: "set_presence",
    label: "Who's present",
    side: "server",
    path: "packages/server/src/agent/tools/presencePart.ts",
    entry: "presencePart",
    files: ["packages/server/src/agent/tools/presencePart.ts"],
    surfaces: ["server:rolloutTools", "server:presence"],
    imports: { "packages/plugin-api/src/server.ts": "@rp/plugin-api/server" }
  },
  {
    registry: "macros",
    id: "reverse",
    label: "Reverse text macro",
    side: "worker",
    path: "packages/shared/src/macros/builtins/reverse.ts",
    entry: "reverseMacro",
    files: ["packages/shared/src/macros/builtins/reverse.ts"],
    surfaces: ["worker:macros"],
    imports: { "packages/shared/src/macros/registry.ts": "@rp/plugin-api/worker" }
  }
] as const
export const builtinCopy = (registry: string, id: string) =>
  builtinCopies.find((p) => p.registry === registry && p.id === id)
