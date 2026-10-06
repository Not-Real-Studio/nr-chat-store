/**
 * Boundary-тест сабпата builder (session-document-spec §4.1, §8): билдер
 * чистый — без `node:*`, драйверов и IO. Легальны: модули `src/builder/`,
 * модель (`../model.js`), сборка (`../assembly/*`) и белый список пакетов —
 * кодек `.mds` (nr-chat), ntpl (nrd/template), типы nunjucks.
 */

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, relative, sep } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '..', 'src')
const BUILDER_DIR = join(SRC, 'builder')
const ALLOWED_PACKAGES = new Set(['@notrealstudio/nr-chat', '@notrealstudio/nrd/template', 'nunjucks'])

function importSpecifiers(source: string): string[] {
  const specs: string[] = []
  for (const re of [/\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g]) {
    let m: RegExpExecArray | null
    while ((m = re.exec(source)) !== null) specs.push(m[1]!)
  }
  return specs
}

describe('builder/ boundary', () => {
  const files = readdirSync(BUILDER_DIR).filter((n) => n.endsWith('.ts')).map((n) => join(BUILDER_DIR, n))

  it('находит модули builder', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    const rel = relative(SRC, file).split(sep).join('/')
    it(`${rel}: builder + модель + assembly + белый список пакетов, без node:*`, () => {
      const violations: string[] = []
      for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('.')) {
          const target = relative(SRC, resolve(dirname(file), spec)).split(sep).join('/')
          if (target === 'model.js' || target.startsWith('builder/') || target.startsWith('assembly/')) continue
          violations.push(spec)
        } else if (!ALLOWED_PACKAGES.has(spec)) {
          violations.push(spec)
        }
      }
      expect(violations, `запрещённые импорты в ${rel}`).toEqual([])
    })
  }
})
