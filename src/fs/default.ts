/**
 * Носитель драйвера, когда `storage` не передан: Node (`node:fs`) — прежнее
 * поведение драйверов. Модуль грузится лениво по вычисляемому спецификатору:
 * бандлер браузера его не тянет (там `storage` передаётся всегда).
 */

import type { IFileSystem } from '@notrealstudio/nr-contracts'

let nodeFs: Promise<IFileSystem> | undefined

export function defaultFileSystem(): Promise<IFileSystem> {
  const spec = './node.js'
  nodeFs ??= (import(/* @vite-ignore */ spec) as Promise<{ createNodeFileSystem(): IFileSystem }>).then((m) => m.createNodeFileSystem())
  return nodeFs
}
