import { describe, expect, it } from 'vitest'

import { splitLines, stripBom } from '../src/text.js'

describe('stripBom', () => {
  it('removes a leading byte order mark', () => {
    expect(stripBom('\uFEFFhello')).toBe('hello')
  })

  it('leaves text without one alone', () => {
    expect(stripBom('hello')).toBe('hello')
    expect(stripBom('')).toBe('')
  })

  it('only removes the mark at the start', () => {
    expect(stripBom('a\uFEFFb')).toBe('a\uFEFFb')
  })
})

describe('splitLines', () => {
  it('splits on line feeds', () => {
    expect(splitLines('a\nb\nc')).toEqual(['a', 'b', 'c'])
  })

  it('splits on carriage return line feed pairs without leaving the return behind', () => {
    expect(splitLines('a\r\nb\r\nc')).toEqual(['a', 'b', 'c'])
  })

  it('splits on lone carriage returns', () => {
    expect(splitLines('a\rb\rc')).toEqual(['a', 'b', 'c'])
  })

  it('handles a file mixing all three endings', () => {
    expect(splitLines('a\r\nb\nc\rd')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('strips a byte order mark before splitting', () => {
    expect(splitLines('\uFEFFa\r\nb')).toEqual(['a', 'b'])
  })

  it('keeps the indentation of each line', () => {
    expect(splitLines('a/\r\n  b.txt\r\n')).toEqual(['a/', '  b.txt', ''])
  })
})
