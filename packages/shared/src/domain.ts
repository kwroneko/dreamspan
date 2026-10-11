import { Schema } from "effect"
import { idSchema } from "./id.ts"

export const UserId = idSchema("UserId", "user")
export type UserId = typeof UserId.Type

export const UserRole = Schema.Literals(["admin", "user"])
export type UserRole = typeof UserRole.Type

export class User extends Schema.Class<User>("User")({
  id: UserId,
  handle: Schema.String,
  displayName: Schema.String,
  role: UserRole
}) {}

/** A user as an admin sees them (DESIGN §10.1). */
export class UserAccount extends Schema.Class<UserAccount>("UserAccount")({
  id: UserId,
  handle: Schema.String,
  displayName: Schema.String,
  role: UserRole,
  hasPassword: Schema.Boolean,
  disabled: Schema.Boolean
}) {}
