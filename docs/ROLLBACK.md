# Upgrade or roll back a Docker deployment

These steps use the `dreamspan` Compose service and `./data` bind mount from the [Docker setup](../docker/README.md). If you use a named volume, take an equivalent cold snapshot and restore it into a fresh volume. Keep one Dreamspan instance per data directory.

## Before upgrading

1. Read the [changelog](../CHANGELOG.md). Record the running version from **Settings → Server status**, the exact image tag or digest, and the deployment configuration. Keep the previous image locally or confirm you can retrieve its digest. A moving tag such as `latest` cannot identify the image to roll back to.
2. Prepare the target image before taking the instance offline. Build it from the target release source with a versioned tag, or use `docker compose pull dreamspan` after setting `DREAMSPAN_IMAGE` to an exact tag or digest from your registry.
3. Tell users when the upgrade will start. Stop Dreamspan, then make a cold backup before starting the target image. The cold backup covers the database and the rest of the deployment state.

   ```sh
   (
     umask 077
     docker compose stop dreamspan &&
       backup_dir=$(mktemp -d ../dreamspan-backup.XXXXXXXX) &&
       cp -a ./data "$backup_dir/" &&
       printf 'Backup directory: %s\n' "$backup_dir"
   )
   ```

   Confirm the service stopped and the copy succeeded before continuing. Copy the whole data mount, including the database and any SQLite sidecar files, media, workshop files, plugins and the generated `secret.key`. Preserve permissions and ownership. Include any separately mounted Files directory and preserve any externally supplied `SECRET_KEY` or `SECRET_KEY_FILE` securely. Keep a protected copy off the Docker host. A backup that includes the key can also unlock the stored API credentials.

## Start the new release

Set `DREAMSPAN_IMAGE` in your Compose configuration to the exact target image. Start it and check the logs:

```sh
docker compose up -d --wait dreamspan
docker compose logs --tail=100 dreamspan
```

Check the startup logs for migrations or refusals. Check that `/healthz` succeeds and that its `X-App-Version` header matches the target. Sign in and confirm **Settings → Server status** shows the expected version and a healthy database check. Open a chat and an attachment, and check that a model connection works. Ask people with tabs open to reload before resuming.

Before migrating an initialized database, Dreamspan writes a standalone SQLite snapshot to `<dataDir>/backups/` (`./data/backups/` in this setup). The filename records the last applied migration, the target migration, and the UTC time, for example `pre-migration-0031-to-0033-20261126T120000.123Z-<uuid>.db`. The logs identify the saved file. Dreamspan stops before applying any migration if it cannot create and verify the backup. Check free disk space and write permissions before restarting. Fresh and up-to-date databases skip the backup.

Dreamspan keeps every completed snapshot, including one taken before a migration that failed. To reclaim disk space, manually remove older snapshots once you have protected copies. Keep the most recent snapshots and any snapshot you need for a supported rollback. If a process was killed during backup, you can remove leftover hidden `.pre-migration-*` staging directories while Dreamspan is stopped.

## Roll back if no new migration ran

Stop Dreamspan, restore the previous image reference and compatible Compose configuration, then run `docker compose up -d --wait dreamspan` on the same data. Verify the version and health after startup. This keeps writes made since the upgrade.

## Recover after a migration ran

Prefer fixing forward on a Dreamspan build that can read the migrated database. If the older image encounters a migration it doesn't recognize, it refuses to start with “This data was made by a newer version of Dreamspan” and says that nothing was changed. The message points to `<dataDir>/backups/` for the automatic snapshot. Leave the migration ledger intact.

If you must roll back the database, tell users the backup time and what they may lose, such as new turns, edits, imports and settings changes. Stop Dreamspan and preserve the current data, including any separately mounted state. Restore the cold backup into a fresh directory and switch the bind mount to that directory, or move the current directory aside before putting the restored copy in its place. Restore the matching secrets and deployment configuration, then start the previous image on the restored data.

To restore from an automatic snapshot when you have the matching deployment files and secrets:

1. Stop Dreamspan. Move the current data directory aside so the migrated database and any SQLite sidecar files are available for recovery.
2. Prepare a fresh data directory with the matching non-database files and secrets. Copy the chosen snapshot into it as `dreamspan.db`, with mode `0600` and ownership that lets the Dreamspan process read and write it. The snapshot is self-contained. Keep any `dreamspan.db-wal`, `dreamspan.db-shm` and `dreamspan.db-journal` from the migrated database in the directory you moved aside.
3. Point the bind mount at the restored directory and start the matching previous image. The automatic snapshot covers SQLite only. Restore matching media, workshop and plugin files, separately mounted state and the original encryption key from the cold backup as needed.

Verify login, database health in **Settings → Server status**, chats, media and a provider connection before reopening access. Keep the migrated copy for investigation or recovery of changes made after the backup.
