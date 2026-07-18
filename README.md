# @notreal/nr-chat-store

Нейтральная модель чат-сессий + контракт хранилища `SessionStore` + реестр
драйверов. Одна модель, одна tree-математика, N драйверов: Claude Code, pi, mds,
а через реестр — SQLite, opencode, тредовые бэкенды и что угодно ещё.

`core` — **zero-dependency**: типы модели, чистая tree-математика и контракт
драйвера. Драйверы подключаются сабпатами (`./mds`, `./pi`, `./claude`), так что
потребитель одного не тащит зависимости чужих.

```
npm install @notreal/nr-chat-store
```

## Идея

Анатомия сообщения (`Part` / `Message` / `SessionInfo`) — общая реальность
хранения и провода: её дом здесь, нижним слоем. `@notreal/nr-ui-protocol`
ре-экспортирует эти типы и остаётся wire-слоем (RunEvent, Capabilities, SSE).

Сессия — **дерево** узлов с явным `parent`. Две проекции одного дерева:

- `toHistory(model)` — активный путь + свайпы; ветки = *альтернативы* (диалог).
  Это `history()` протокола для любого драйвера бесплатно.
- `toThread(model)` — обход дерева целиком (DFS, глубина на узле); ветки живут
  все (треды: reddit / discord / комментарии).

## Модель

```ts
interface SessionModel {
  info: SessionInfo
  meta?: Record<string, unknown>   // sessionMeta; meta.activeLeaf — активный лист
  nodes: StoreNode[]               // append-порядок хранилища, всё дерево целиком
}

interface StoreNode {
  id: string                       // стабильный; драйвер без родных id даёт 'pos:N'
  parent: string | null            // ЯВНЫЙ; null = корень
  role: string
  name?: string
  parts: Part[]
  flags?: MessageFlags             // hidden / frozen / injected
  meta?: Record<string, unknown>   // model / usage / createdAt + драйверо-специфика
}
```

`parent` в модели всегда явный. «Chain default» (нет parent = предыдущая нода) и
прочие шорткаты кодирования — конвенции *драйверов*: они разворачивают их при
`load` и сворачивают при записи.

## Контракт драйвера

```ts
interface SessionStore {
  capabilities(): Promise<StoreCapabilities>
  list(opts?): Promise<{ sessions: SessionInfo[]; cursor?: string }>
  load(id): Promise<SessionModel>
  create(opts?): Promise<SessionInfo>
  delete?(id): Promise<void>

  appendNode(sid, node): Promise<StoreNode>        // parent default: активный лист
  editNode?(sid, nid, patch): Promise<StoreNode>   // patch.ifHash → conflict
  deleteNode?(sid, nid): Promise<void>             // дети → на родителя удаляемого
  hideNode?(sid, nid, hidden): Promise<void>
  setActiveLeaf?(sid, nid): Promise<void>          // swipe-примитив
  forkCopy?(sid, atNodeId?): Promise<SessionInfo>

  meta?; assets?; version?(sid); close?()
}
```

- **Полностью асинхронный** — драйвер может быть облачным (HTTP, логин,
  пагинация cursor'ом). Локальные не платят за облачные проблемы.
- **Опциональный метод ⟺ capability**: read-only драйвер = только `list`/`load` —
  легален. Незаявленное отсутствует.
- **`ifHash` — обязательная детекция конфликта**: mismatch → ошибка `conflict`,
  молчаливая перезапись запрещена.
- **Хирургия — контрактное свойство мутаций**: записи, не затронутые операцией,
  в хранилище не переписываются (mds — байты вне спана; JSONL — verbatim-строки).
  Обратная совместимость с чужими данными в том же хранилище — по построению.

## Драйверы v1

| драйвер | capabilities | формат |
|---|---|---|
| `./mds` | всё (edit/delete/hide, swipes, fork, rename, assets, sessionMeta) | `.mds` (кодек слит в драйвер, сабпат `./mds`) |
| `./pi` | edit/delete/hide, swipes, fork | pi session JSONL v3 |
| `./claude` | fork (read + append; edit/delete = false) | транскрипты Agent SDK |

```ts
import { register, getStore, toHistory } from '@notreal/nr-chat-store'
import { createMdsStore } from '@notreal/nr-chat-store/mds'
import { createPiStore } from '@notreal/nr-chat-store/pi'
import { createClaudeStore } from '@notreal/nr-chat-store/claude'

register('mds', (o) => createMdsStore(o as any))
const store = getStore('mds', { dir: './sessions' })

const { id } = await store.create({ info: { title: 'demo' } })
await store.appendNode(id, { role: 'user', text: 'привет' })
const model = await store.load(id)
console.log(toHistory(model))
```

Внешние драйверы (sqlite/opencode/…) регистрируются тем же `register` —
привилегий у встроенной тройки нет.

## Зависимости

- `core` — zero-dep.
- `./mds` — optional peer `@notrealstudio/nr-chat` (кодек mds слит в драйвер).
- `./pi`, `./claude` — только node builtins.
- **toon — не зависимость нигде**: кодеки body (`format`) инъектируются
  потребителем через `decoders`.

## Лицензия

MIT
