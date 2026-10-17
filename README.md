# factory-practice-memo
Practice target app built by the L5 factory: a small memo API

## Usage

```sh
PORT=3000 npm start   # listens on 127.0.0.1 only
npm test              # node:test suite (spawns the server on a random port)
```

Endpoints: `POST/GET /memos`, `GET/PATCH/PUT/DELETE /memos/:id`. Storage is in-memory (no dependencies, Node 22 stdlib only).
