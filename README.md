# factory-practice-memo
Practice target app built by the L5 factory: a small memo API

## Usage

```sh
PORT=3000 npm start   # listens on 127.0.0.1 only
npm test              # node:test suite (spawns the server on a random port)
```

Endpoints: `POST/GET /memos`, `GET/PATCH/PUT/DELETE /memos/:id`. Storage is in-memory (no dependencies, Node 22 stdlib only).

- Memo: `{ id, title, body, tags, version, createdAt, updatedAt }`. `tags` are trimmed, lowercased and de-duplicated (each 1–50 chars, at most 20). `version` starts at 1 and goes up by 1 on each update.
- `PATCH`/`PUT /memos/:id` require `version` (the last version seen). If it is stale, the response is `409 {"error", "current"}`. PUT resets omitted `body`/`tags`; PATCH leaves them unchanged.
- `GET /memos` returns `{ items, nextCursor }` in creation order. Query: `tag` (repeatable, AND), `q` (body search: every whitespace-separated term must appear, case-insensitive), `limit` (1–100, default 20), `cursor` (the `nextCursor` from the previous page; `null` means the last page).

### History and revert

- `GET /memos/:id/history` returns `{ items, nextCursor }`, oldest first (ascending `version`). Every successful create (`"create"`, version 1), `PATCH`/`PUT` (`"update"`) and revert (`"revert"`) adds one entry `{ version, title, body, tags, updatedAt, action, revertedFrom }`. Failed requests (400/404/409) add nothing. `limit` is 1–100 (default 20); an invalid `limit` or a cursor that is malformed or belongs to another memo gives 400. Unknown or deleted memo gives 404 (history is removed with the memo). No cap on entries.
- `POST /memos/:id/revert` with `{ toVersion, version }` restores `title`, `body` and `tags` from the history entry `toVersion` (its stored content, so reverting to a revert entry restores what that entry produced). On success it returns 200 with the memo; `version` goes up by 1, `updatedAt` is set to now, `createdAt` stays the same. The new entry has `action: "revert"` and `revertedFrom: toVersion`. An entry is recorded even if the restored content is the same as the current content.
- Errors, in order of checking: unknown memo → 404; body that is not a JSON object, or `toVersion`/`version` missing or not a positive integer → 400; stale `version` → 409 `{ error, current }` (memo unchanged); `toVersion` equal to the current version → 400; `toVersion` greater than the current version → 404.
- Concurrency: revert uses the same atomic compare-and-set on `version` as `PATCH`/`PUT`. When reverts and/or updates race with the same `version`, exactly one succeeds and the others get 409.
- Unsupported methods give 405 with `Allow: GET` (history) or `Allow: POST` (revert).
