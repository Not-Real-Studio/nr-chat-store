# @notrealstudio/nr-chat-store

A neutral chat-session model + the `SessionStore` storage contract + a driver
registry. One model, one set of tree math, N drivers: Claude Code, pi, nr-chat,
and — through the registry — SQLite, opencode, thread backends, or anything else.

The `core` is **zero-dependency**: model types, pure tree math, and the driver
contract. Drivers plug in as subpaths (`./nr-chat`, `./pi`, `./claude`), so a
consumer of one does not drag in the dependencies of the others.

```
npm install @notrealstudio/nr-chat-store
```

## Idea

Message anatomy (`Part` / `Message` / `SessionInfo`) is the shared reality of
storage and wire: its home is here, at the bottom layer. A wire layer such as an
UI protocol re-exports these types and stays the wire (RunEvent, Capabilities,
SSE) on top of them.

A session is a **tree** of nodes with an explicit `parent`. Two projections of
the one tree:

- `toHistory(model)` — the active path + swipes; branches = *alternatives*
  (dialogue). This is a driver's `history()` for free.
- `toThread(model)` — the whole tree traversed (DFS, depth per node); all
  branches live (threads: reddit / discord / comments).

## Model

```ts
interface SessionModel {
  info: SessionInfo
  meta?: Record<string, unknown>   // sessionMeta; meta.activeLeaf — the active leaf
  nodes: StoreNode[]               // storage append order, the whole tree
}

interface StoreNode {
  id: string                       // stable; a driver with no native ids emits 'pos:N'
  parent: string | null            // EXPLICIT; null = root
  role: string
  name?: string
  parts: Part[]
  flags?: MessageFlags             // hidden / frozen / injected
  meta?: Record<string, unknown>   // model / usage / createdAt + driver specifics
}
```

`parent` in the model is always explicit. "Chain default" (no parent = the
previous node) and other encoding shortcuts are *driver* conventions: they are
unfolded on `load` and folded back on write.

## Driver contract

```ts
interface SessionStore {
  capabilities(): Promise<StoreCapabilities>
  list(opts?): Promise<{ sessions: SessionInfo[]; cursor?: string }>
  load(id): Promise<SessionModel>
  create(opts?): Promise<SessionInfo>
  delete?(id): Promise<void>

  appendNode(sid, node): Promise<StoreNode>        // parent default: the active leaf
  editNode?(sid, nid, patch): Promise<StoreNode>   // patch.ifHash → conflict
  deleteNode?(sid, nid): Promise<void>             // children → the deleted node's parent
  hideNode?(sid, nid, hidden): Promise<void>
  setActiveLeaf?(sid, nid): Promise<void>          // swipe primitive
  forkCopy?(sid, atNodeId?): Promise<SessionInfo>

  meta?; assets?; version?(sid); close?()
}
```

- **Fully async** — a driver can be cloud-backed (HTTP, login, cursor
  pagination). Local drivers don't pay for cloud problems.
- **Optional method ⟺ capability**: a read-only driver = only `list`/`load` — is
  legal. What is not declared is absent.
- **`ifHash` is a mandatory conflict check**: a mismatch → a `conflict` error;
  silent overwrite is forbidden.
- **Surgery is a contractual property of mutations**: records untouched by an
  operation are not rewritten in storage (nr-chat — bytes outside the span; JSONL
  — verbatim lines). Backward compatibility with foreign data in the same store
  is by construction.

## Drivers v1

| driver | capabilities | format |
|---|---|---|
| `./nr-chat` | everything (edit/delete/hide, swipes, fork, rename, assets, sessionMeta) | `.mds` files (nr-chat codec, subpath `./nr-chat`) |
| `./pi` | edit/delete/hide, swipes, fork | pi session JSONL v3 |
| `./claude` | fork (read + append; edit/delete = false) | Agent SDK transcripts |

```ts
import { register, getStore, toHistory } from '@notrealstudio/nr-chat-store'
import { createNrChatStore } from '@notrealstudio/nr-chat-store/nr-chat'
import { createPiStore } from '@notrealstudio/nr-chat-store/pi'
import { createClaudeStore } from '@notrealstudio/nr-chat-store/claude'

register('nr-chat', (o) => createNrChatStore(o as any))
const store = getStore('nr-chat', { dir: './sessions' })

const { id } = await store.create({ info: { title: 'demo' } })
await store.appendNode(id, { role: 'user', text: 'hello' })
const model = await store.load(id)
console.log(toHistory(model))
```

External drivers (sqlite/opencode/…) register through the same `register` — the
built-in trio has no privileges.

## Dependencies

- `core` — zero-dep.
- `./nr-chat` — optional peer `@notrealstudio/nr-chat` (the nr-chat codec lives
  in the driver). Install it alongside when you use the `./nr-chat` subpath.
- `./pi`, `./claude` — node builtins only.
- **toon is a dependency nowhere**: body codecs (`format`) are injected by the
  consumer through `decoders`.

## License

MIT
