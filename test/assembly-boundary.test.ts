/**
 * Boundary-тест сабпата assembly (spec §7, по образцу NOT-279).
 *
 * Инвариант: ни один модуль `src/assembly/**` не выходит за границу «формат
 * линеек». Легальны только: относительные импорты, остающиеся ВНУТРИ
 * `src/assembly/`, и белый список внешних спецификаторов — модель пакета
 * (`../model.js`). Никаких драйверов, IO, `node:*`. Красный тест = граница пробита.
 */

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, relative, sep } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ASSEMBLY_DIR = resolve(HERE, '..', 'src', 'assembly')

/** Спецификаторы вне assembly/, которые импортировать МОЖНО (белый список). */
const ALLOWED_OUTSIDE = new Set(['../model.js'])

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...tsFiles(full))
    else if (name.endsWith('.ts')) out.push(full)
  }
  return out
}

/** Все import/export … from '<spec>' и dynamic import('<spec>'). */
function importSpecifiers(source: string): string[] {
  const specs: string[] = []
  const fromRe = /\bfrom\s*['"]([^'"]+)['"]/g
  const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const re of [fromRe, dynRe]) {
    let m: RegExpExecArray | null
    while ((m = re.exec(source)) !== null) specs.push(m[1])
  }
  return specs
}

describe('assembly/ boundary', () => {
  const files = tsFiles(ASSEMBLY_DIR)

  it('находит модули assembly', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    const rel = relative(ASSEMBLY_DIR, file).split(sep).join('/')
    it(`${rel}: импортирует только assembly + модель`, () => {
      const specs = importSpecifiers(readFileSync(file, 'utf8'))
      const violations: string[] = []
      for (const spec of specs) {
        if (spec.startsWith('.')) {
          // Относительный: либо в белом списке (../model.js), либо остаётся внутри assembly/.
          if (ALLOWED_OUTSIDE.has(spec)) continue
          const target = resolve(dirname(file), spec)
          const relToDir = relative(ASSEMBLY_DIR, target)
          if (relToDir.startsWith('..') || relToDir.split(sep)[0] === '..') violations.push(spec)
        } else {
          // Bare-спецификатор (пакет, node:*) — запрещён полностью.
          violations.push(spec)
        }
      }
      expect(violations, `запрещённые импорты в ${rel}`).toEqual([])
    })
  }
})
