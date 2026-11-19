import { Effect } from "effect"
import { fixtureSql } from "../../../server/test/support/lcmFixtures.ts"
import { asUser } from "./rpc.ts"
import { ADMIN, type TestServer } from "./server.ts"
import type { EntityId } from "@dreamspan/shared/chat.ts"

/** Entirely synthetic, also used for the review preview. */
export const seedCardArchive = (server: TestServer, forkFamily = false) =>
  asUser(server, ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const userId = (yield* api.Whoami()).id
      const fresh = yield* api.CreateCard({ label: "Fresh pilot", name: "Fresh pilot" })
      const now = Date.now()
      yield* fixtureSql(server.dataDir, [
        {
          sql: "INSERT INTO entities(id,owner_user_id,kind,created_at,archived_at,forked_from_entity_id) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<199) SELECT printf('archive-e-%03d',i), ?, 'card', ? - (45 + (i%4)*100)*86400000, CASE WHEN i<=5 THEN ? END, CASE WHEN ?=1 AND i IN(9,12) THEN 'archive-e-008' END FROM n",
          params: [userId, now, now, forkFamily ? 1 : 0]
        },
        {
          sql: "INSERT INTO entity_revisions(id,entity_id,doc_json,doc_hash,schema_version,origin,created_at) SELECT 'archive-v-'||e.id, e.id, json_set(src.doc_json,'$.name','Pilot '||substr(e.id,-3),'$.description','A synthetic explorer of imagined islands.'), e.id, src.schema_version, 'import', e.created_at FROM entities e, entity_revisions src WHERE src.id=? AND e.id LIKE 'archive-e-%'",
          params: [fresh.headRevisionId]
        },
        {
          sql: "INSERT INTO entity_revisions(id,entity_id,parents,doc_json,doc_hash,schema_version,origin,created_at) SELECT 'archive-edit-'||e.id,e.id,json_array(src.id),json_set(src.doc_json,'$.description','An older saved synthetic edit.'),'edited-'||e.id,src.schema_version,'user',e.created_at+86400000 FROM entities e JOIN entity_revisions src ON src.entity_id=e.id WHERE e.id LIKE 'archive-e-%' AND cast(substr(e.id,-3) AS INTEGER)%10=0"
        },
        {
          sql: "INSERT INTO entity_refs(id,entity_id,head_revision_id,label,created_at,updated_at) SELECT 'archive-r-'||id,id,CASE WHEN cast(substr(id,-3) AS INTEGER)%10=0 THEN 'archive-edit-'||id ELSE 'archive-v-'||id END,id,created_at,created_at FROM entities WHERE id LIKE 'archive-e-%'"
        }
      ])
      yield* api.SetCardFavourite({ entityId: "archive-e-006" as EntityId, favourite: true })
      yield* api.SetPersona({ entityId: "archive-e-005" as EntityId, persona: true })
      for (const n of [7, 11, 15]) {
        const id = `archive-e-${String(n).padStart(3, "0")}` as EntityId
        yield* api.StartChat({
          cards: [id],
          persona: null,
          greeting: 0,
          first: { _tag: "Send", content: "Let us explore this synthetic island.", speakerEntityId: null }
        })
      }
      return { userId, fresh }
    })
  )
