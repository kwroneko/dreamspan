// Who a new workshop of its own starts with, chosen on the Chats page's Workshop card and on the
// page of the workshop not made yet (`/new/workshop`): URL keys, an entity id each, absent for the
// workshop default; the persona's `NO_PERSONA` for none. Its title is a user draft until it's made.
export const WORKSHOP_CARD_KEY = "workshopCard"
export const WORKSHOP_PERSONA_KEY = "workshopPersona"
/**
 * Library items its first message carries ("Work on in a workshop" → A new workshop,
 * spec/WORKSHOP-CARDS.md §4.1 point 3): ref ids joined by commas.
 */
export const WORKSHOP_ATTACH_KEY = "workshopAttach"
export const NO_PERSONA = "none"
/** Where a new workshop's title is kept until it's made: the start card and the page share it. */
export const NEW_WORKSHOP_TITLE = "workshop:new"
/** Where the first message typed on that page is kept. */
export const NEW_WORKSHOP_COPY = "pending-workshop:new"
