// Saved card media (spec/SAVED-MEDIA.md): media a library entry names on other sites, saved on
// this server and shown from it. Registered like any other feature: the lookup and the approval
// dialog in the app shell, a section in each editor, and its settings page.
import { MediaSitesPage } from "./MediaSitesPage.tsx"
import { routes } from "../../routes.tsx"
import { savedMedia } from "../../ui/html/savedMedia.ts"
import { cardEditorSections, lorebookEditorSections } from "../editor/cardSections.ts"
import { presetEditorSections } from "../editor/presetSections.ts"
import { appBanners } from "../shell.tsx"
import { SavedMediaHost } from "./SavedMediaHost.tsx"
import { SavedMediaSection } from "./SavedMediaSection.tsx"

export const register = () => {
  savedMedia.expect()
  return [
    appBanners.register({ id: "media.saved", order: 0, component: SavedMediaHost }),
    cardEditorSections.register({ id: "card.saved-media", order: 118, component: SavedMediaSection }),
    presetEditorSections.register({ id: "preset.saved-media", order: 130, component: SavedMediaSection }),
    lorebookEditorSections.register({ id: "lorebook.saved-media", order: 110, component: SavedMediaSection }),
    routes.register({
      id: "settings.media-sites",
      parent: "settings",
      path: "media-sites",
      component: MediaSitesPage,
      nav: {
        label: "Media sites",
        order: 32,
        description: "The sites card images, sounds and fonts are saved from without asking."
      }
    })
  ]
}
