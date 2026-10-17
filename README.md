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
