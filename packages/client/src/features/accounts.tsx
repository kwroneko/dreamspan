// Your account, and for admins everyone's (DESIGN §10.1). The rules (the last admin,
// an admin without a password) are the server's: this shows its answers.
import type { UserAccount, UserId, UserRole } from "@dreamspan/shared/domain.ts"
import { type FormEvent, useState } from "react"
import { AsyncView, ErrorAlert, useAction } from "../actions.tsx"
import { routes } from "../routes.tsx"
import { AppClient } from "../rpc.ts"
import { useSession } from "../session.ts"
import { Button } from "../ui/Button.tsx"
import { ConfirmDialog, Dialog, DialogActions } from "../ui/Dialog.tsx"
import { Field, formText, Input, PasswordInput } from "../ui/Field.tsx"
import { Select } from "../ui/Select.tsx"
import { Alert, Badge, Card, CardHeader } from "../ui/Surface.tsx"
import { useDurableForm, useOpenPlace } from "./editor/durable.tsx"
import { LogoutButton, useTitle } from "./shell.tsx"

const usersAtom = AppClient.query("ListUsers", undefined, { reactivityKeys: ["users"] })

const howSignedIn = {
  session: "You logged in with your password.",
  local:
    "No account has a password, so anyone on this machine (or an allowed address) is the admin without logging in. Set a password to require a login.",
  loopback: "This server lets its own machine in as the admin without logging in.",
  proxy: "Your reverse proxy signs you in and out, and manages passwords."
} as const

function OwnPasswordForm() {
  const session = useSession()
  const action = useAction()
  const [nextEmpty, setNextEmpty] = useState(true)
  // With a session you logged in with a password; with "local" nobody has one. Otherwise
  // it's unknown, so the field is offered and may stay empty.
  const asksCurrent = session.via !== "local"

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const current = asksCurrent ? formText(event.currentTarget, "current") : ""
    const next = formText(event.currentTarget, "next")
    const result = await action.run((client) =>
      client("SetPassword", {
        userId: session.user.id,
        currentPassword: current !== "" ? current : null,
        newPassword: next
      })
    )
    // Every session of yours ended, this one included.
    if (result.ok) location.replace("/login?changed=1")
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {asksCurrent && (
        <Field
          label="Current password"
          about={session.via === "session" ? undefined : "Leave empty if you don't have one yet."}
        >
          <PasswordInput name="current" autoComplete="current-password" />
        </Field>
      )}
      <Field label="New password" about="Use at least 8 characters. You’ll need to log in again on every device.">
        <PasswordInput name="next" autoComplete="new-password" onEmptyChange={setNextEmpty} />
      </Field>
      <ErrorAlert error={action.error} title="The password wasn't changed" />
      <div>
        <Button
          hint="Opens the password form."
          type="submit"
          variant="primary"
          pending={action.pending}
          disabled={nextEmpty}
        >
          {session.via === "local" ? "Set password" : "Change password"}
        </Button>
      </div>
    </form>
  )
}

function AccountPage() {
  useTitle("Account")
  const session = useSession()
  return (
    <div data-account-page className="flex flex-col gap-4">
      <Card>
        <CardHeader center title="Account" actions={session.via === "session" ? <LogoutButton /> : undefined} />
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
          <dt className="text-muted">Name</dt>
          <dd>{session.user.displayName}</dd>
          <dt className="text-muted">Handle</dt>
          <dd className="font-mono">{session.user.handle}</dd>
          <dt className="text-muted">Role</dt>
          <dd>{session.user.role}</dd>
        </dl>
        <p className="mt-3 text-sm text-muted">{howSignedIn[session.via]}</p>
      </Card>
      {session.via !== "proxy" && (
        <Card>
          <CardHeader title="Password" />
          <OwnPasswordForm />
        </Card>
      )}
    </div>
  )
}

const roleItems = [
  {
    value: "user" as const,
    label: "User",
    description: "Can use their own characters, chats and settings."
  },
  {
    value: "admin" as const,
    label: "Admin",
    description: "Can also manage accounts, passwords and the server’s network settings."
  }
]

function CreateUserDialog({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const action = useAction()
  // The password is a secret, never kept; the rest is kept as typed.
  const form = useDurableForm("new-user", "New user", { handle: "", displayName: "", role: "user" as UserRole })
  const { handle, displayName, role } = form.values
  const [passwordEmpty, setPasswordEmpty] = useState(true)
  const close = () => {
    void form.discard()
    onOpenChange(false)
  }
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const password = formText(event.currentTarget, "password")
    await form.commit(async (values) => {
      const result = await action.run((client) => client("CreateUser", { ...values, password }), ["users"])
      if (result.ok) onOpenChange(false)
      return result.ok
    })
  }
  return (
    <Dialog open onOpenChange={(open) => !open && close()} title="New user" placement="top-on-phone">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Handle" about="The sign-in name: letters, digits, '.', '_' and '-'.">
          <Input
            value={handle}
            readOnly={!form.ready}
            onValueChange={(next) => form.edit({ handle: next })}
            autoCapitalize="none"
            spellCheck={false}
            autoComplete="off"
          />
        </Field>
        <Field label="Display name (optional)">
          <Input
            value={displayName}
            readOnly={!form.ready}
            onValueChange={(next) => form.edit({ displayName: next })}
            autoComplete="off"
          />
        </Field>
        <Field label="Role">
          <Select items={roleItems} value={role} onValueChange={(next) => form.edit({ role: next })} />
        </Field>
        <Field label="Password" about="At least 8 characters.">
          <PasswordInput name="password" autoComplete="new-password" onEmptyChange={setPasswordEmpty} />
        </Field>
        <ErrorAlert error={action.error} title="No user created" />
        <DialogActions>
          {form.refusedAction}
          <Button hint="Closes this dialog without applying changes." onClick={close}>
            Cancel
          </Button>
          <Button
            hint="Creates the user account."
            type="submit"
            variant="primary"
            pending={action.pending}
            disabled={handle === "" || passwordEmpty}
          >
            Create user
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

function SetPasswordDialog({ user, onOpenChange }: { user: UserAccount; onOpenChange: (open: boolean) => void }) {
  const action = useAction()
  const [passwordEmpty, setPasswordEmpty] = useState(true)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const password = formText(event.currentTarget, "password")
    const result = await action.run(
      (client) => client("SetPassword", { userId: user.id, currentPassword: null, newPassword: password }),
      ["users"]
    )
    if (result.ok) onOpenChange(false)
  }
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={`Set ${user.displayName}'s password`}
      description="They’ll need to log in again on every device with the new password."
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="New password" about="At least 8 characters.">
          <PasswordInput name="password" autoComplete="new-password" onEmptyChange={setPasswordEmpty} />
        </Field>
        <ErrorAlert error={action.error} title="The password wasn't set" />
        <DialogActions>
          <Button hint="Closes this dialog without applying changes." onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            hint="Sets this user’s password."
            type="submit"
            variant="primary"
            pending={action.pending}
            disabled={passwordEmpty}
          >
            Set password
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

function UserRow({ user, self }: { user: UserAccount; self: UserId }) {
  const toggle = useAction()
  const [dialog, setDialog] = useState<"password" | "disable" | null>(null)
  const close = (open: boolean) => {
    if (!open) setDialog(null)
  }
  const setDisabled = async (disabled: boolean) => {
    const result = await toggle.run((client) => client("SetUserDisabled", { userId: user.id, disabled }), ["users"])
    if (result.ok) setDialog(null)
  }
  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{user.displayName}</span>
            <span className="font-mono text-sm text-muted">{user.handle}</span>
            {user.role === "admin" && <Badge tone="accent">admin</Badge>}
            {user.id === self && <Badge>you</Badge>}
            {!user.hasPassword && <Badge tone="warning">no password</Badge>}
            {user.disabled && <Badge tone="danger">disabled</Badge>}
          </div>
        </div>
        {user.id !== self && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              hint="Gives them a new password. Their sessions end."
              onClick={() => setDialog("password")}
            >
              Set password
            </Button>
            {user.disabled ? (
              <Button
                variant="ghost"
                pending={toggle.pending}
                hint="Lets them log in again."
                onClick={() => void setDisabled(false)}
              >
                Enable
              </Button>
            ) : (
              <Button hint="Disables this user’s account." variant="ghost" onClick={() => setDialog("disable")}>
                Disable
              </Button>
            )}
          </div>
        )}
      </div>
      {dialog === null && <ErrorAlert error={toggle.error} />}
      {dialog === "password" && <SetPasswordDialog user={user} onOpenChange={close} />}
      {dialog === "disable" && (
        <ConfirmDialog
          open
          onOpenChange={close}
          title={`Disable ${user.displayName}?`}
          description="They’ll be logged out on every device and can’t log in until enabled again. Their data stays."
          confirmLabel="Disable"
          pending={toggle.pending}
          onConfirm={() => void setDisabled(true)}
        >
          <ErrorAlert error={toggle.error} />
        </ConfirmDialog>
      )}
    </li>
  )
}

function UsersPage() {
  useTitle("Users")
  const session = useSession()
  const [creating, setCreating] = useOpenPlace("new-user")
  return (
    <Card>
      <CardHeader
        center
        title="Users"
        about="There's no sign-up: an admin creates each account."
        actions={
          session.via === "proxy" ? undefined : (
            <Button hint="Opens a form to create a user." variant="primary" onClick={() => setCreating(true)}>
              New user
            </Button>
          )
        }
      />
      {session.via === "proxy" && (
        <div className="mb-4">
          <Alert>Your reverse proxy creates users when they first arrive. You can still disable them here.</Alert>
        </div>
      )}
      <AsyncView atom={usersAtom} loading="Loading users…">
        {(users) => (
          <ul className="flex flex-col divide-y divide-border" aria-label="Users">
            {users.map((user) => (
              <UserRow key={user.id} user={user} self={session.user.id} />
            ))}
          </ul>
        )}
      </AsyncView>
      {creating && <CreateUserDialog onOpenChange={setCreating} />}
    </Card>
  )
}

export const register = () => {
  routes.register({
    id: "settings.account",
    parent: "settings",
    path: "account",
    component: AccountPage,
    nav: { label: "Account", order: 40, description: "Your account and your password." }
  })
  routes.register({
    id: "settings.users",
    parent: "settings",
    path: "users",
    component: UsersPage,
    nav: {
      label: "Users",
      order: 50,
      adminOnly: true,
      description: "Everyone's accounts. There's no sign-up: an admin creates each one."
    }
  })
}
