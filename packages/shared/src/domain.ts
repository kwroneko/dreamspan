import { Schema } from "effect"

export const UserId = Schema.String.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type

export const UserRole = Schema.Literals(["admin", "user"])
export type UserRole = typeof UserRole.Type

export class User extends Schema.Class<User>("User")({
  id: UserId,
  handle: Schema.String,
  displayName: Schema.String,
  role: UserRole
}) {}
