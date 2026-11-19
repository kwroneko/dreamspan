#!/bin/sh
# The image's entrypoint (docker/README.md, "A memory cap per command"). Started as the image's
# user (node), it runs the server as it is. Started as root (compose `user: "0:0"`), it gives the
# server a cgroup subtree of its own, so each command gets a real memory cap
# (packages/server/src/sandbox/cgroupLimits.ts), and then runs the server as node (uid 1000):
#
# 1. A user namespace mapping root and node to themselves, with new mount and cgroup
#    namespaces. Root there may mount a cgroup2 view of the container's own cgroup, read-write
#    (Docker's /sys/fs/cgroup is read-only); it holds no capability on the host.
# 2. In it: /run/dreamspan-cgroup is that view; this process moves to rp/server, the memory and pids
#    controllers are handed down to rp, and rp is given to node. Commands' groups are made
#    under rp, beside the server's.
# 3. setpriv drops to node with no capabilities and no_new_privs (a setuid binary can't
#    become root of the namespace, which owns the cgroup view's top), and the server starts with
#    COMMAND_CGROUP=/run/dreamspan-cgroup/rp.
#
# Any step failing: the server runs as node without it, and the "Run commands" row says the
# limits are weaker. Nothing here is needed for the server itself.
set -u
CGROUP_VIEW=/run/dreamspan-cgroup
NODE_UID=1000
NODE_GID=1000

as_node() {
  exec setpriv --reuid="$NODE_UID" --regid="$NODE_GID" --clear-groups --no-new-privs --inh-caps=-all --bounding-set=-all -- "$@"
}

if [ "$(id -u)" != 0 ]; then
  exec "$@"
fi

if [ "${DREAMSPAN_CGROUP_STEP:-}" = inside ]; then
  unset DREAMSPAN_CGROUP_STEP
  if mkdir -p "$CGROUP_VIEW" \
    && mount -t cgroup2 -o nosuid,nodev,noexec cgroup2 "$CGROUP_VIEW" \
    && mkdir -p "$CGROUP_VIEW/rp/server" \
    && echo $$ > "$CGROUP_VIEW/rp/server/cgroup.procs" \
    && echo "+memory +pids" > "$CGROUP_VIEW/cgroup.subtree_control" \
    && echo "+memory +pids" > "$CGROUP_VIEW/rp/cgroup.subtree_control" \
    && chown -R "$NODE_UID:$NODE_GID" "$CGROUP_VIEW/rp"; then
    export COMMAND_CGROUP="$CGROUP_VIEW/rp"
  else
    echo "dreamspan-entrypoint: no cgroup subtree for commands; they run with weaker limits." >&2
    unset COMMAND_CGROUP
  fi
  as_node "$@"
fi

# util-linux mounts through the new mount API (fsopen), which Docker's seccomp profile allows
# only with CAP_SYS_ADMIN; mount(2) is what docker/seccomp-userns.json allows.
export LIBMOUNT_FORCE_MOUNT2=always
NAMESPACES="--user --map-users=0:0:1 --map-users=$NODE_UID:$NODE_UID:1 --map-groups=0:0:1 --map-groups=$NODE_GID:$NODE_GID:1 --mount --cgroup --propagation private"
# shellcheck disable=SC2086 # NAMESPACES is a list of options.
if unshare $NAMESPACES true 2>/dev/null; then
  export DREAMSPAN_CGROUP_STEP=inside
  # shellcheck disable=SC2086
  exec unshare $NAMESPACES /bin/sh "$0" "$@"
fi
echo "dreamspan-entrypoint: can't make the namespaces for a cgroup subtree; commands run with weaker limits." >&2
as_node "$@"
