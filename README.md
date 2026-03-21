# sync-app

Simple bidirectional folder synchronization over WebSocket. A Node.js server publishes one or more "shares" (folder roots); each client picks a share and a local directory to mirror. All creations, updates, and deletions in the share or from any client are streamed over `ws` so every connected client stays in sync.

## Setup
1. Install dependencies:
   ```bash
   npm install
   ```
2. The server share metadata lives in `server/config.json`. Each entry requires a `name` and `path` pointing inside `server/shared/` (paths are resolved relative to `server/`). The code validates that at least one share exists before starting so typos are caught early.

## Running the server
```bash
npm run server
```
The WebSocket endpoint opens on the port defined in `server/config.json` (defaults to `3001`). You can override the defaults with environment variables:

| Env var | Description |
|---------|-------------|
| `PORT` / `SYNC_PORT` | overrides the port the WS server listens on. |
| `LOG_LEVEL` | one of `debug`, `info`, `warn`, or `error` controls the colorized logging level. |
| `SYNC_SHARES` | JSON array of share definitions (matching the shape from `config.json`) if you prefer to keep configuration outside the repository. |

When the server starts it ensures each share folder exists, opens a `chokidar` watcher, and broadcasts every filesystem event to every connected client (excluding the emitter). The share watcher suppresses the next automatic event that is triggered by an applied remote change, which keeps the loop from re-broadcasting its own updates.

## Running a client
```bash
npm run client
```
Default arguments are pulled from `client/settings.js` and can be overridden with either CLI flags or environment variables:

| Flag | Env var | Description |
|------|---------|-------------|
| `--log-level` | `LOG_LEVEL` | Client-specific verbosity (`debug`, `info`, `warn`, `error`). Defaults to `info`. |
| `--choose-local` | | Prompt for the local folder path interactively before syncing. |

Set `SYNC_SERVER_URL`, `SYNC_SHARE`, or `SYNC_LOCAL_DIR` in your environment to temporarily override the values stored in `client/config.json`.

If you want to override the server URL, share name, or default mirror path without editing `client/config.json`, set `SYNC_SERVER_URL`, `SYNC_SHARE`, or `SYNC_LOCAL_DIR` in your environment before running `npm run client`.

You can add a `sharePaths` map inside `client/config.json` so each share uses its own default mirror location. For example, `"sharePaths": {"projects": "./client-projects", "photos": "~/shared-photos"}` lets the client pick the correct folder automatically when you run `npm run client -- --share projects`.

Add the `reconnectDelayMs` property (milliseconds) to control how long the client waits before reconnecting when the WebSocket closes; the default is `5000`.

Both `server/config.json` and `client/config.json` are now auto-generated with sensible defaults when they don’t exist yet, so running `npm run server` or `npm run client` the first time will create those files for you automatically.

You can put a `client/config.json` next to `client/index.js` (see the sample file) to persist sensible defaults there; the client will automatically merge that JSON with any flags or environment variables you pass.

A newly connected client requests a full snapshot (`share-list` + `snapshot`), clears the local mirror, copies everything over, and then starts its own watcher. After that, it streams every local change to the server, and the server replays those edits back into the share so every peer receives the update.

## Logging & error handling
- Timestamps and log levels are colorized using ANSI escape codes so you can scan the console quickly. File/edit activity messages are logged at `info` level (`share filesystem change`, `local filesystem change detected`, `remote change applied locally`, etc.), and `debug` adds more detail for suppressed events or republished changes.
- Both the server and client register `uncaughtException` / `unhandledRejection` handlers, along with `watcher`/`WebSocket` error listeners, so fatal problems are logged before the process exits.

## Trash bin
- When a client deletes a file, the server moves it into `trash-bin/<timestamp>/…` inside the share root before informing the other peers. The mirror still receives the delete event, but the data is preserved until someone inspects or clears the trash folder manually.
- The share watcher ignores `trash-bin`, so the trash bin is never re-broadcast or mirrored back to clients automatically. Delete something again inside `trash-bin` (or remove `trash-bin/<timestamp>` entirely) if you want to permanently drop it.
- Move-to-trash now skips files that disappear between the delete request and the rename (such as nested `.git` directories that already vanished or were inaccessible); those deletes still propagate to clients, but nothing is logged as a failure.

## Ignored paths
- Shares ignore `.git` trees by default to avoid permission errors and extra noise. Add an `ignoredPaths` array to a share definition (or override it with `[]`) to customize the folders that should never be synced.
- Clients honor the same `ignoredPaths` list when watching the local mirror and when applying snapshots, so your ignored directories stay untouched even when the mirror is rebuilt.

## Extending shares
Add another entry to `server/config.json` like:
```json
{
  "name": "notes",
  "path": "./shared/notes"
}
```
Create `server/shared/notes`, populate it, and clients can sync it with `--share notes`.
