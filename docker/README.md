# Run Dreamspan in Docker

Build the first release from its source checkout with Docker and Compose. From the repository root:

```sh
docker build -t dreamspan:0.1.0 .
mkdir -p data
```

Use a local filesystem for `./data` and make it writable by the image's `node` user (UID 1000 for a standard Docker setup). Create `../dreamspan-secrets/admin-password` outside the checkout with a single strong password of at least eight characters. Give only the operator and the container user access to the file.

Save this as `compose.yaml` beside the Dockerfile:

```yaml
services:
  dreamspan:
    image: ${DREAMSPAN_IMAGE:-dreamspan:0.1.0}
    ports:
      - "${DREAMSPAN_BIND_ADDRESS:?Set this to the host's IPv4 loopback address}:8080:8080"
    volumes:
      - ./data:/data
    environment:
      ADMIN_USER: admin
      ADMIN_PASSWORD_FILE: /run/secrets/admin_password
    secrets:
      - admin_password

secrets:
  admin_password:
    file: ../dreamspan-secrets/admin-password
```

Set `DREAMSPAN_BIND_ADDRESS` to your host's IPv4 loopback address in the Compose `.env` file. Run `docker compose up -d --wait` and open that address on port 8080 over HTTP. Sign in as `admin` with the password you chose. This file seeds the password when there is no enabled admin with a password. Change it in **Settings → Account** after signing in.

For remote use, put the app behind an HTTPS reverse proxy that supports WebSockets. Set `PUBLIC_ORIGINS` to the exact browser-facing origin and keep the app's port private. If the proxy supplies the user identity, configure proxy authentication and trusted peers as described in the [architecture guide](../ARCHITECTURE.md#4-authentication).

See the [user guide](../docs/GUIDE.md) for first-run setup, the [changelog](../CHANGELOG.md) for release changes, and the [upgrade and rollback runbook](../docs/ROLLBACK.md) before updating.

## Running the container with the command sandbox

The workshop's `bash` and `search_files` tools run each command in a bubblewrap sandbox
(spec/FILES-AND-ENVIRONMENT.md §3, ARCHITECTURE.md "Files and commands"). Bubblewrap needs
unprivileged user namespaces, and Docker's defaults block them in two ways. Without the settings
below the server still runs, the file tools still work, and the workshop's "Run commands" row
says why commands are unavailable.

### Settings

To enable sandboxed commands, add the following settings to the service above. Keep its other settings, including data and authentication.

```yaml
services:
  dreamspan:
    user: "0:0"                                 # the entrypoint drops to node (uid 1000); see below
    cgroup: private                             # the container's own cgroup namespace (Docker's default on cgroup v2)
    mem_limit: 8g                               # the container's cap: the server and every command together
    security_opt:
      - seccomp=./docker/seccomp-userns.json   # Docker's default profile plus namespace calls
      - systempaths=unconfined                  # lets the sandbox mount its own /proc
      # Hosts with AppArmor (Ubuntu, Debian with AppArmor on), after loading the profile:
      # - apparmor=dreamspan
    environment:
      # Set PUBLIC_ADDRESSES here if the server is behind NAT (see below).
      # Each account's Files quota by default (files, versions and home folder together).
      # FILES_QUOTA: "10G"
```

With `docker run`: `--user 0:0 --cgroupns private --security-opt seccomp=docker/seccomp-userns.json
--security-opt systempaths=unconfined` (plus `--security-opt apparmor=dreamspan` on AppArmor
hosts).

- **seccomp-userns.json** is Docker's default profile (moby/profiles, `seccomp/default.json`)
  with one rule added at the end: it allows `clone`, `unshare`, `mount`, `umount2`,
  `pivot_root` and `sethostname` without `CAP_SYS_ADMIN`. The default profile only
  allows them to containers that hold that capability. Each of the six was checked to be
  needed (bubblewrap fails without it); `setns` was not, so it isn't added. The container still
  runs without any added capability; `mount` and the rest only succeed inside a user namespace,
  where the kernel checks capabilities against that namespace, not the host. The server
  process itself can now create user namespaces too, as any unprivileged process can on a
  stock Linux host; the commands can't (`--disable-userns`). The rest of Docker's default
  filter (no `keyctl`, `bpf`, `perf_event_open`, `userfaultfd`, `io_uring`) still applies to
  the commands, since they inherit it.
- **systempaths=unconfined** stops Docker from masking parts of `/proc` and `/sys` with
  read-only overmounts. The kernel refuses a new `/proc` mount in a namespace that can see a
  partly covered `/proc`, so the sandbox couldn't mount the `/proc` of its own PID namespace
  without it. The sandbox's commands never see the container's `/proc`. The server runs as
  uid 1000, not root, so the unmasked files it could now reach are the ones the kernel already
  refuses to unprivileged users (`/proc/kcore`, `/proc/sysrq-trigger`, `/proc/timer_list`);
  what it gains is listings such as `/proc/acpi` and `/sys/firmware`. Never run the server
  itself as root with it; `user: "0:0"` starts only the entrypoint as root, which drops to
  uid 1000 before the server starts.

Do not use `--privileged` or `--cap-add SYS_ADMIN` instead: either gives the server process
itself powers it doesn't need.

## A memory cap per command

Each command gets a cgroup v2 of its own with `memory.max` (the command's memory, 4 GiB by
default, all its processes, shared mappings, memfds and `/tmp` together), `memory.swap.max`
= 0 and `pids.max` (`packages/server/src/sandbox/cgroupLimits.ts`). A per-process limit
(`ulimit -d`) doesn't count shared memory: a 1.5 GiB shared mapping passed a 1 GiB `ulimit`.
Running out, the whole command is killed (`memory.oom.group`) and its result says it used too
much memory.

Docker mounts the container's `/sys/fs/cgroup` read-only, and the server runs as uid 1000, so
the image's entrypoint (`docker/entrypoint.sh`) makes a writable subtree when the container
starts as root (`user: "0:0"`):

1. It enters a new user namespace that maps root and node (uid 1000) to themselves, with new
   mount and cgroup namespaces. Root there holds no capability on the host, but may mount a
   cgroup2 view of the container's own cgroup, read-write, at `/run/dreamspan-cgroup`.
2. It moves itself to `rp/server`, hands the memory and pids controllers down to `rp`, and gives
   `rp` to node. Commands' groups are made under `rp`, beside the server's.
3. `setpriv` drops to node with no capabilities, and the server starts with
   `COMMAND_CGROUP=/run/dreamspan-cgroup/rp`.

At startup the server checks that it can make and limit a group there, and logs which limiter
commands use. `docker exec` (and the health check) still work: Docker puts them in the
server's group.

Without `user: "0:0"`, or where a step fails (no `cgroup: private`, a seccomp or AppArmor
profile that refuses the mounts), the server runs as node without it: commands keep the
per-process limits and the container's `mem_limit`, and the "Run commands" row says "Commands
run with weaker limits here." Set `mem_limit` in any case: it is the cap on the server and all
commands together.

Outside Docker (for example a server run as a systemd user service), commands get a transient scope
from `systemd-run --user --scope -p MemoryMax=… -p MemorySwapMax=0 -p TasksMax=…`, which needs
nothing set up. The server checks once a minute that the user manager really applies those
limits (some don't delegate the memory controller).

## AppArmor

Docker's `docker-default` profile blocks two things bubblewrap needs: `mount`, and writes under
`/proc/sys` (its `--disable-userns` writes `0` to `/proc/sys/user/max_user_namespaces` in the
sandbox's own user namespace, so commands can't make further ones). `docker/apparmor-dreamspan` is
`docker-default` (as Docker 29 generates it) with `deny mount` replaced by `mount`, `remount`,
`pivot_root` and `userns`, and the `/proc/sys` write denial narrowed so that exactly one file,
`/proc/sys/user/max_user_namespaces`, can be written. Every other rule is the same (the other
`/proc` and `/sys` write denials, no `/sys/firmware`, `/sys/kernel/security`, `kcore` or
`sysrq-trigger`). The kernel still checks each mount and each write against the namespace's own
capabilities, so the server, without `CAP_SYS_ADMIN`, can mount only inside a user namespace of
its own. It replaces `apparmor=unconfined`, which removed AppArmor from the whole server process.

```sh
sudo apparmor_parser -r -W docker/apparmor-dreamspan   # load (and on each boot, e.g. from /etc/apparmor.d)
docker info | grep -i apparmor                           # AppArmor hosts list it among the security options
```

Then `security_opt: apparmor=dreamspan`. `userns,` is an AppArmor 4 rule (Ubuntu 23.10 and
later restrict unprivileged user namespaces to profiles that allow them); AppArmor 3 parsers
(Debian 12) don't know it: delete that line there. Hosts without AppArmor need nothing.

**Tested at runtime** (Ubuntu, kernel 6.8, AppArmor 4.0.1, Docker 29): with the settings above
and this profile loaded, the command sandbox's probe (`bwrap --unshare-user --unshare-pid
--unshare-net --disable-userns ... --proc /proc`) passes as root and as uid 1000. With the
previous profile it failed with "bwrap: cannot open /proc/sys/user/max_user_namespaces: Permission
denied". Loopback setup for `--unshare-net` needed nothing beyond the seccomp file.

## Commands may not reach the server itself

Commands reach the internet through a proxy that refuses private, loopback and link-local
addresses and the server's own interface addresses. Behind NAT (a router's port forward,
Docker's published ports) the server's public address is on no interface, and a command
reaching it would reach the router's forwards and the app itself as an anonymous internet
user. So the proxy also refuses:

- the addresses in `PUBLIC_ADDRESSES` (IPs, CIDR ranges or host names, comma-separated);
- the addresses the hosts of `PUBLIC_ORIGINS` resolve to (the app's own URL), kept resolved.

Set `PUBLIC_ADDRESSES` to the router's public address when the app's URL doesn't resolve to it
(a VPN, a tunnel, split DNS). The proxy also reaches ports 80 and 443 only, for tunnels and
plain HTTP alike.

**DNS:** with Internet on, the proxy resolves every name a command asks for, refused ones
included, through the host's resolver. A command can therefore leak data in the names it
looks up (DNS exfiltration). That comes with having internet at all, and isn't prevented; with
Internet from commands Off there is no proxy and no lookup.

## Host requirements

The kernel must allow unprivileged user namespaces (`/proc/sys/user/max_user_namespaces` > 0;
on Debian before 11, `kernel.unprivileged_userns_clone=1`), and use cgroup v2 for the memory cap.
Checked on Linux 6.12 with Docker 29.7.2: with the seccomp and system-path settings, a command
in the image runs as the sandbox's own user, sees only its files, runs git, python3, rg and
node, reaches a public site, and is refused access to loopback. With only the seccomp file it fails with
"Can't mount proc on /proc", and with neither with "No permissions to create a new namespace".

## What the image adds

The final stage installs `bubblewrap` and the tools commands find inside the sandbox: git,
python3 (with pip and venv), ripgrep, curl, procps, xz-utils, unzip, less and file. Node is the
image's own. This adds about 170 MB (403 MB against 230 MB for the base image).
The entrypoint (`/usr/local/bin/dreamspan-entrypoint`) uses util-linux's `unshare` and `setpriv`, already
in the base image.

## Outside Docker

A server run as a systemd user service needs nothing extra: bubblewrap from the host's
packages, the kernel's unprivileged user namespaces, and the user manager for the per-command
scopes. `COMMAND_SANDBOX` names the sandbox to use (`linux-bwrap` is the only one); empty picks
the first available. `COMMAND_CGROUP` names a delegated cgroup subtree the server may write,
for hosts that make one themselves. `MCP_LOCAL_PROGRAMS=on` lets admins add MCP servers that are
local programs; they run in the same sandbox (off by default).

`HOST_FOLDERS` (comma-separated absolute paths) lists folders on the server an admin may choose
as a workshop's working folder; in Docker these are folders you mount into the container. System
folders and the app's own data are refused. `ALLOW_UNSANDBOXED_COMMANDS=1` lets an admin turn the
sandbox off for one workshop after a consent; commands then run as the app's user and can read
every account's data. Neither is ever offered to other accounts.
