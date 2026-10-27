/**
 * Архив и теги сессий (DEV-354, session-archive-spec): разбор `sessionMeta.archived` / `tags`.
 * Общий для стора, бэкендов и фронта — одно правило нормализации тегов.
 */

/** `sessionMeta.archived` → дата ISO / `false` (вернули руками); прочее — нет. */
export function archivedOf(v: unknown): string | false | undefined {
  if (v === false) return false
  return typeof v === 'string' && v !== '' ? v : undefined
}

/** Теги (DEV-354): строки, без `#` и пробелов по краям, нижний регистр, без повторов, до 40 знаков. */
export function normTags(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const t of v) {
    if (typeof t !== 'string') continue
    const x = t.trim().replace(/^#+/, '').trim().toLowerCase().slice(0, 40)
    if (x && !out.includes(x)) out.push(x)
  }
  return out
}
