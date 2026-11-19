// node scripts/check-released-migrations.ts: fails (exit 1) when a migration that a recorded
// release ran (packages/server/test/fixtures/releases) was edited, renamed or removed, the baseline
// and every statement it imports included, or when a new migration is numbered at or below the
// newest release's last one. For the deploy gate, before a keep-mode deploy; the same rule is a
// unit test (packages/server/test/releasedSchema.test.ts). ARCHITECTURE.md §3.7 "Released schemas".
import { migrationDefinitions } from "../packages/server/src/db/migrations.ts"
import { readReleases, releasedMigrationProblems } from "../packages/server/src/db/releases.ts"

const releases = readReleases()
const problems = releasedMigrationProblems(migrationDefinitions, releases)
if (problems.length > 0) {
  for (const problem of problems) console.error(`RELEASED MIGRATION CHANGED: ${problem}`)
  process.exit(1)
}
console.log(
  `Released migrations unchanged: ${releases.length} release(s) recorded, newest ${releases.at(-1)?.release ?? "none"}.`
)
