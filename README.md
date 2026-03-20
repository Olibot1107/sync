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
npm run client -- --share projects --local ~/my-projects
```
Default arguments are pulled from `client/settings.js` and can be overridden with either CLI flags or environment variables:

| Flag | Env var | Description |
|------|---------|-------------|
| `--server` | `SYNC_SERVER_URL` | WebSocket URL to connect to (default `ws://localhost:3001`). |
| `--share` | `SYNC_SHARE` | Share name you want to mirror (default `projects`). |
| `--local` | `SYNC_LOCAL_DIR` | Local directory for the mirror (default `./client-sync`). |
| `--log-level` | `LOG_LEVEL` | Client-specific verbosity (`debug`, `info`, `warn`, `error`). Defaults to `info`. |

A newly connected client requests a full snapshot (`share-list` + `snapshot`), clears the local mirror, copies everything over, and then starts its own watcher. After that, it streams every local change to the server, and the server replays those edits back into the share so every peer receives the update.

### Sequential processing
- Both the server and client now run every filesystem operation through a tiny serial queue (`lib/serialQueue.js`). Each queued job completes before the next one starts, so when you move files “one by one,” the events arrive over the network in the same order you performed them and the console logs reflect that serialized flow.  
- Watcher events, remote changes, and shared-folder writes emit `info`-level log lines before the next queue entry executes, which keeps the console output easy to follow and prevents operations from racing.

### Lazy downloads
- The client mirror only stores directories and metadata (`localDir/.sync/metadata.json`) on connect; file contents are downloaded on demand so you don't consume disk space for untouched files.  
- Use `npm run client-fetch -- --path docs/readme.md --share projects --local ~/my-projects` (or `npm run client-prefetch` for folders) to queue one or more download requests. Each script writes a small JSON request into `.sync/prefetch/`; the running client picks it up, downloads the file contents via the WebSocket, writes them to the mirror, and marks the metadata entry as `downloaded: true` while suppressing the watcher so it never re-uploads what just arrived.

### Prefetch directories on demand
- Run `npm run client-prefetch -- --path docs/src --share projects --local ~/my-projects` (or point your file manager/editor at that script) whenever you open a folder; the script writes a JSON request into `.sync/prefetch/`, the client picks it up, and every file under that directory is downloaded sequentially before the next request runs.  
- The client keeps track of each directory’s files in `localDir/.sync/metadata.json`, so only the needed files are fetched and your watcher waits until the download finishes before emitting updates.

## Logging & error handling
- Timestamps and log levels are colorized using ANSI escape codes so you can scan the console quickly. File/edit activity messages are logged at `info` level (`share filesystem change`, `local filesystem change detected`, `remote change applied locally`, etc.), and `debug` adds more detail for suppressed events or republished changes.
- Both the server and client register `uncaughtException` / `unhandledRejection` handlers, along with `watcher`/`WebSocket` error listeners, so fatal problems are logged before the process exits.

## Extending shares
Add another entry to `server/config.json` like:
```json
{
  "name": "notes",
  "path": "./shared/notes"
}
```
Create `server/shared/notes`, populate it, and clients can sync it with `--share notes`.
