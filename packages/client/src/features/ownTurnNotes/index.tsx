import { fieldViews } from "../editor/fieldViews.ts"
import { OwnTurnFieldView } from "./fields.tsx"

export const register = () => [fieldViews.register({ id: "own-turn-notes.field", component: OwnTurnFieldView })]
