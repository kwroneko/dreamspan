// Global setup for the live suite: the server tests' temporary-directory run, without the
// worker bundle build. Live tests run the database and format workers from source
// (TEST_DB_WORKERS=source, set by the project): their time goes to provider round trips,
// and a bundle build on a loaded host took minutes.
import { makeSetup } from "../../support/globalSetup.ts"

export default makeSetup(null)
