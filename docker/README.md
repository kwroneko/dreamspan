# Running the container with the command sandbox

The workshop's `bash` and `search_files` tools run each command in a bubblewrap sandbox
(spec/FILES-AND-ENVIRONMENT.md §3, ARCHITECTURE.md "Files and commands"). Bubblewrap needs
unprivileged user namespaces, and Docker's defaults block them in two ways. Without the settings
below the server still runs, the file tools still work, and the workshop's "Run commands" row
says why commands are unavailable.

## Settings

```yaml
services:
  rp:
    image: rp-harness
    security_opt:
      - seccomp=./docker/seccomp-userns.json   # Docker's default profile plus namespace calls
      - systempaths=unconfined                  # lets the sandbox mount its own /proc
      # Hosts with AppArmor (Ubuntu, Debian with AppArmor on) also need:
      # - apparmor=unconfined
```

With `docker run`: `--security-opt seccomp=docker/seccomp-userns.json --security-opt systempaths=unconfined`
(plus `--security-opt apparmor=unconfined` on AppArmor hosts).

- **seccomp-userns.json** is Docker's default profile (moby/profiles, `seccomp/default.json`)
  with one rule added at the end: it allows `clone`, `unshare`, `mount`, `umount2`,
  `pivot_root`, `setns` and `sethostname` without `CAP_SYS_ADMIN`. The default profile only
  allows them to containers that hold that capability. The container still runs without any
  added capability; the calls only work inside the user namespaces bubblewrap creates, where
  the kernel checks capabilities against the namespace, not the host.
- **systempaths=unconfined** stops Docker from masking parts of `/proc` and `/sys` with
  read-only overmounts. The kernel refuses a new `/proc` mount in a namespace that can see a
  partly covered `/proc`, so the sandbox couldn't mount the `/proc` of its own PID namespace
  without it. The sandbox's commands never see the container's `/proc`.
- **AppArmor:** Docker's `docker-default` profile denies `mount`. Hosts without AppArmor (the test host
  has it off) don't need the setting; `docker info` lists `apparmor` among the security
  options where it is on. Ubuntu 23.10 and later also restrict
  unprivileged user namespaces on the host (`kernel.apparmor_restrict_unprivileged_userns=1`);
  such hosts need that sysctl set to 0 or an AppArmor profile that allows `userns`.

Do not use `--privileged` or `--cap-add SYS_ADMIN` instead: either gives the server process
itself powers it doesn't need.

## Host requirements

The kernel must allow unprivileged user namespaces (`/proc/sys/user/max_user_namespaces` > 0;
on Debian before 11, `kernel.unprivileged_userns_clone=1`). Checked on the test host (Linux 6.12, Docker
29.7.2): with the two settings above, a command in the image runs as the sandbox's own user,
sees only its files, runs git, python3, rg and node, reaches a public site, and is refused
127.0.0.1; with only the seccomp file it fails with "Can't mount proc on /proc", and with
neither with "No permissions to create a new namespace".

## What the image adds

The final stage installs `bubblewrap` and the tools commands find inside the sandbox: git,
python3 (with pip and venv), ripgrep, curl, procps, xz-utils, unzip, less and file. Node is the
image's own. This adds about 170 MB (measured on the test host: 403 MB against 230 MB for the base image).

## Outside Docker

a development server (a systemd user service) needs nothing extra: bubblewrap from the host's
packages and the kernel's unprivileged user namespaces. `COMMAND_SANDBOX` names the sandbox
to use (`linux-bwrap` is the only one); empty picks the first available.
