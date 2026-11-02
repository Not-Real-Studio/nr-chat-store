/** Картинка без mime (DEV-609/610): не превращается в файл при записи и чтении `%%attach`. */
import { describe, expect, it } from 'vitest'
import { imageMimeOf, partToSubMessage, subNodeToPart } from '../src/nr-chat/parts.js'
import type { Part } from '../src/model.js'

const roundTrip = (p: Part): Part => {
  const m = partToSubMessage(p)
  return subNodeToPart({ kind: 'attach', name: m.name, body: m.body, meta: m.meta } as never)
}

describe('картинка без mime', () => {
  it('mime по расширению ref', () => {
    const back = roundTrip({ type: 'image', meta: { ref: 'file:s.assets/shot.PNG' } } as Part)
    expect(back.type).toBe('image')
    expect((back.meta as { mime?: string }).mime).toBe('image/png')
  })
  it('без расширения — пометка kind: image, обратно картинка', () => {
    const m = partToSubMessage({ type: 'image', meta: { ref: 'file:s.assets/blob' } } as Part)
    expect(m.meta).toMatchObject({ kind: 'image' })
    const back = roundTrip({ type: 'image', meta: { ref: 'file:s.assets/blob', alt: 'image' } } as Part)
    expect(back.type).toBe('image')
    expect(back.meta).not.toHaveProperty('kind')
  })
  it('старый %%attach без mime с расширением картинки — картинка; .pdf — файл', () => {
    expect(subNodeToPart({ kind: 'attach', name: 'a.jpg', body: '', meta: { file: 'file:x/a.jpg' } } as never).type).toBe('image')
    expect(subNodeToPart({ kind: 'attach', name: 'a.pdf', body: '', meta: { file: 'file:x/a.pdf' } } as never).type).toBe('file')
    expect(imageMimeOf('data:image/webp;base64,AAA')).toBe('image/webp')
  })
})
