/**
 * Оценка токенов текста — та же формула, что `estimateTokens` nr-ui-protocol
 * (attachments-spec §2): `ascii / 4.4 + nonAscii / 2.75`, по code points.
 *
 * Копия, а не импорт: протокол зависит от этого пакета (модель), обратная
 * зависимость дала бы цикл, а сабпат assembly — zero-dep (boundary-тест).
 * Совпадение формул держит тест-вектор в тестах backend-nr.
 */

const TOKEN_CHARS_ASCII = 4.4
const TOKEN_CHARS_NON_ASCII = 2.75

export function estimateTokens(text: string): number {
  let ascii = 0
  let nonAscii = 0
  for (const ch of text) {
    if (ch.charCodeAt(0) < 0x80) ascii++
    else nonAscii++
  }
  return Math.ceil(ascii / TOKEN_CHARS_ASCII + nonAscii / TOKEN_CHARS_NON_ASCII)
}
