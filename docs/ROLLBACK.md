# Upgrade or roll back a Docker deployment

These steps use the `dreamspan` Compose service and `./data` bind mount from the [Docker setup](../docker/README.md). If you use a named volume, take an equivalent cold snapshot and restore it into a fresh volume. Keep one Dreamspan instance per data directory.

## Before upgrading

1. Read the [changelog](../CHANGELOG.md). Record the running version from **Settings → Server status**, the exact image tag or digest, and the deployment configuration. Keep the previous image locally or confirm you can retrieve its digest. A moving tag such as `latest` cannot identify the image to roll back to.
2. Prepare the target image before taking the instance offline. Build it from the target release source with a versioned tag, or use `docker compose pull dreamspan` after setting `DREAMSPAN_IMAGE` to an exact tag or digest from your registry.
3. Tell users when the upgrade will start. Stop Dreamspan, then make a cold backup before starting the target image. Dreamspan currently relies on the operator for this backup.

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

## Roll back if no new migration ran

Stop Dreamspan, restore the previous image reference and compatible Compose configuration, then run `docker compose up -d --wait dreamspan` on the same data. Verify the version and health after startup. This keeps writes made since the upgrade.

## Recover after a migration ran

Prefer fixing forward on a Dreamspan build that can read the migrated database. If the older image encounters a migration it doesn't recognize, it refuses to start with “This data was made by a newer version of Dreamspan” and says that nothing was changed. This protects the database. Leave the migration ledger intact.

If you must roll back the database, tell users the backup time and what they may lose, such as new turns, edits, imports and settings changes. Stop Dreamspan and preserve the current data, including any separately mounted state. Restore the cold backup into a fresh directory and switch the bind mount to that directory, or move the current directory aside before putting the restored copy in its place. Restore the matching secrets and deployment configuration, then start the previous image on the restored data.

Verify login, database health in **Settings → Server status**, chats, media and a provider connection before reopening access. Keep the migrated copy for investigation or recovery of changes made after the backup.
