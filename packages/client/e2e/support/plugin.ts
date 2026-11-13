/** Synthetic source only. Used by browser tests and the image smoke. */
export const pluginFiles = (id: string, body?: string, surfaces = ["composerControls", "chatPanels"]) => ({
  "rp-plugin.json": JSON.stringify({
    id,
    name: id,
    api: 1,
    server: null,
    worker: null,
    client: "client.tsx",
    surfaces: surfaces.map((s) => `client:${s}`),
    overrides: [],
    replaces: [],
    network: false,
    base: null
  }),
  "client.tsx":
    body ??
    `import { ui, type Activate } from "@rp/plugin-api/client";
export const activate: Activate = host => {
  host.registries.composerControls!.register({ id: "${id}.roll", order: 5, placement: "tools", component: ({draft}) => <ui.IconButton hint="Adds a synthetic roll to your draft" aria-label="Roll ${id}" onClick={() => draft.append("🎲 20")}>🎲</ui.IconButton> });
  host.registries.chatPanels!.register({ id: "${id}.panel", label: "${id}", description: "Shows synthetic plugin information", order: 0, component: ({chatId}) => <p>Plugin panel for {chatId}</p> });
};`
})
