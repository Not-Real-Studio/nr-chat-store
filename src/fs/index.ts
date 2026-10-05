/**
 * `@notrealstudio/nr-chat-store/fs` — носители без Node (DEV-226): `IFileSystem`
 * в памяти, обёртка с исключениями, пути с прямым слешем, SHA-256 и base64 на
 * чистом JS. Node-реализация — сабпат `./node-fs`.
 */

export { createMemoryFileSystem, type MemoryFileSystem } from './memory.js'
export { fsOf, type Fs } from './facade.js'
export { basename, dirname, isAbsolute, isInside, join, normalize, relative, resolve, sep, toSlash } from './path.js'
export { fromBase64, randomUUID, sha256, sha256Hex, toBase64, toHex, utf8 } from './sha256.js'
