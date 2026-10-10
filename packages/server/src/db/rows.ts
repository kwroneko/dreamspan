// Row shapes and their mapping to domain types, shared by the writer and readers.
import { User, type UserId } from "@rp/shared/domain.ts"

export interface UserRow {
  readonly id: string
  readonly handle: string
  readonly display_name: string
  readonly role: "admin" | "user"
}

export const toUser = (row: UserRow) =>
  new User({ id: row.id as UserId, handle: row.handle, displayName: row.display_name, role: row.role })
