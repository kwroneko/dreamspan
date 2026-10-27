# Unit A fix 5

Branch: `unit-a-fix4`. Merged current master first (`04aa9bb`); the merge brought in specification updates, but this fix makes no edits to `spec/`. No push. All test data is synthetic; no owner chat logs or character definitions were read.

| Finding | Change | Permanent coverage |
| --- | --- | --- |
| N5: legacy collision | `packages/server/src/db/stImportWrites.ts:852` recovers legacy placement during claim, before collision matching at `:493`. The importer supplies the resolved parent at `packages/server/src/importer/StImports.ts:866`; its optional writer argument is declared in `packages/server/src/db/ops.ts:1431`. Both legacy shapes recover their original name/clear before adopting another path. Collision protection also covers unnamed targets. | `packages/server/test/stImportNamePlacement.test.ts:599`, `legacy-custom` and `legacy-auto`, each with imported/default, local name and explicit clear. The fixture removes `parentRecordId` as well as the old placement fields. Tests preserve old paths, selected versions, other children and identical replay. |
| N6: lost parent metadata | `packages/server/src/db/stImportWrites.ts:731` reconciles every merged record, retaining the last resolved parent in the payload and allowing an empty parent path when unavailable. Missing current metadata no longer bypasses transfer. | Same suite at `:599`, `missing-parent` and `unresolved-parent`, each with imported name, local name and clear, old-path/version preservation and two replays. `packages/server/test/isolation.test.ts:2131` probes the new parent-record argument and claim ownership in both user directions. |
| N7: parent writer change then child swipe | `packages/server/src/db/stImportWrites.ts:757` restricts transfers to the newly created independent suffix. A truncation with no new suffix retains its unreachable choice. Shared and abandoned original slots keep both naming fields. | `packages/server/test/stImportNamePlacement.test.ts:695`, three raw shared-root/abandoned-path probes assert main's naming/provenance, selected versions, the old child path, transferred pair and stable replay. The oracle traces at `:557` cover the same two edits with all three choices; `:565` covers subsequent truncation. |
| Oracle blind spot | `packages/server/test/stImportNamePlacement.test.ts:303` finds a transfer target among new slots rather than accepting an existing shared prefix. At `:342`, only an initial placement can use the previously unclaimed-slot exception. Existing choices and all original slots remain protected even for unnamed main and abandoned paths. | The three deterministic `protects shared history after parent writer then child swipe` cases use the actual seeded-test fixtures and the strengthened oracle. Against unfixed merged code, all three fail a placement assertion. |

The implemented invariant and recovery behavior are recorded in `ARCHITECTURE.md:1227`.

## Verification

- Unfixed-code control: `VITEST_MAX_WORKERS=4 npx vitest run packages/server/test/stImportNamePlacement.test.ts -t 'shared history after|legacy-custom:|legacy-auto:|missing-parent:'`: **12 expected assertion failures**, 18 skipped, 75.78 seconds. This ran after adding the tests/oracle and before editing the writer. All six legacy cases, three missing-parent cases and three oracle cases failed; none failed by timeout. See `before-fix.log`.
- Parent and ownership focused run: `VITEST_MAX_WORKERS=4 npx vitest run packages/server/test/stImportNamePlacement.test.ts packages/server/test/isolation.test.ts -t 'legacy collision and missing parent|StImportClaim'`: **14 passed**, 364 skipped, 139.56 seconds. See `parent-isolation5.log`.
- Larger relevant regression run: **8 files, 89 tests passed**, 527.19 seconds (`relevant5.log`). Covered placement, fork names and their review regressions, shared selections, reimport, local deletion, fork bin behavior and paths.
- Shared history/truncation focused run on final writer: **9 passed**, 30 skipped, 158.16 seconds (`shared-history5.log`). Covers the strengthened-oracle traces, raw N7 reproductions and no-new-suffix truncation for imported/local/clear choices.
- Initial typecheck found an exact-optional-property call-site error; fixed by omitting the unresolved optional argument. Final typecheck is included in the full check below.
- Full check: `sh ~/projects/work-folder/2026-10-27/env VITEST_MAX_WORKERS=4 npm run check`: **exit 1**. Typecheck, ESLint, Prettier and Knip passed. Vitest: **159 files passed, 6 failed, 1 skipped; 2,691 tests passed, 13 failed, 1 skipped**, 2,103.80 seconds. All fork-name suites, the final 39-test placement suite and the ownership matrix passed. Output: `full-check5.log`. This is not a green full check. The skip is the existing opt-in ST import benchmark.

| Failed full-run file | Cases and evidence |
| --- | --- |
| `historyPerf.test.ts` | 100,000-message prior-history-start case exceeded its 60-second timeout. |
| `inspectorReview.test.ts` | Malformed legacy snapshot fixture: `database is locked`. |
| `lcmReviewScale.test.ts` | Three 300 ms enqueue budgets: 521.059 ms (condensation), 367.427 ms (hidden prefix), 434.191 ms (empty prefix). |
| `lcmSummarizer.test.ts` | Refused-summary failed-row count: 2 versus 1, line 207. |
| `providerInventory.test.ts` | Four ambient SDK authentication/header/routing cases exceeded 30 seconds (OpenAI chat/responses, Anthropic, Google). |
| `startup.test.ts` | Three five-second prompt-exit budgets: missing DATA_DIR with generated/configured secret, and file DATA_DIR with generated secret. |

**All 13 failed cases passed on isolated rerun**, sequentially, without source changes or budget increases, in six focused invocations. No second full check was run. This does not turn the original full check green or establish each failure's cause. Logs are `rerun5-<file>.log`.

| Isolated rerun | Tests | Duration |
| --- | --- | --- |
| `lcmSummarizer.test.ts` | 1 passed \| 4 skipped (5) | 14.65s (tests 71%, transform 16%, import 13%) |
| `lcmReviewScale.test.ts` | 3 passed \| 1 skipped (4) | 57.57s (tests 88%, transform 6%, import 6%) |
| `inspectorReview.test.ts` | 1 passed \| 10 skipped (11) | 13.47s (tests 46%, transform 31%, import 22%) |
| `historyPerf.test.ts` | 1 passed \| 2 skipped (3) | 59.30s (tests 97%, import 2%, transform 1%) |
| `providerInventory.test.ts` | 4 passed \| 11 skipped (15) | 52.92s (tests 93%, transform 4%, import 3%) |
| `startup.test.ts` | 3 passed \| 5 skipped (8) | 9.71s (tests 94%, import 4%, transform 2%) |

Every rerun used `VITEST_MAX_WORKERS=4 npx vitest run packages/server/test/<file>.test.ts -t <failed-case pattern>`; the next invocation started only after the previous one exited. The selected patterns covered exactly the 13 full-run failures. The full check and these reruns left source and test budgets unchanged.
- `git diff --check`: passed.
