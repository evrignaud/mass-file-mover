import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  buildLevel,
  compareStrings,
  findNewParts,
  fromPosix,
  normalizeDirectory,
  readLevel,
  resolveDestination,
  sortPaths,
  splitDirectory,
  toPosix
} from '../src/paths.js'

describe('toPosix / fromPosix', () => {
  it('writes native separators as slashes', () => {
    expect(toPosix(path.join('a', 'b', 'c.txt'))).toBe('a/b/c.txt')
  })

  it('reads slashes back as native separators', () => {
    expect(fromPosix('a/b/c.txt')).toBe(path.join('a', 'b', 'c.txt'))
  })

  it('round-trips', () => {
    const native = path.join('one', 'two', 'three.txt')
    expect(fromPosix(toPosix(native))).toBe(native)
  })
})

describe('splitDirectory', () => {
  it('treats the scanned root as no segments', () => {
    expect(splitDirectory('.')).toEqual([])
    expect(splitDirectory('')).toEqual([])
    expect(splitDirectory('./')).toEqual([])
  })

  it('splits on slashes and drops the empty parts', () => {
    expect(splitDirectory('a/b')).toEqual(['a', 'b'])
    expect(splitDirectory('./a/b/')).toEqual(['a', 'b'])
    expect(splitDirectory('a//b')).toEqual(['a', 'b'])
  })
})

describe('sortPaths', () => {
  it('groups files by directory, then orders by name', () => {
    expect(sortPaths(['b/z.txt', 'a.txt', 'b/a.txt', 'B.txt'])).toEqual([
      'a.txt',
      'B.txt',
      'b/a.txt',
      'b/z.txt'
    ])
  })

  it('places the root before its sub-directories', () => {
    expect(sortPaths(['a/b/one.txt', 'root.txt', 'c/three.txt', 'a/two.txt'])).toEqual([
      'root.txt',
      'a/two.txt',
      'a/b/one.txt',
      'c/three.txt'
    ])
  })

  it('ignores case when ordering', () => {
    expect(sortPaths(['Zebra.txt', 'apple.txt'])).toEqual(['apple.txt', 'Zebra.txt'])
  })
})

describe('compareStrings', () => {
  it('orders case-insensitively', () => {
    expect(compareStrings('a', 'B')).toBe(-1)
    expect(compareStrings('B', 'a')).toBe(1)
    expect(compareStrings('a', 'A')).toBe(0)
  })
})

describe('findNewParts', () => {
  it('reports every segment as new when nothing is open yet', () => {
    expect(findNewParts('', 'a')).toEqual({ newLevel: 0, parts: ['a'] })
    expect(findNewParts('.', 'a/b')).toEqual({ newLevel: 0, parts: ['a', 'b'] })
  })

  it('keeps the shared prefix and only reports what is deeper', () => {
    expect(findNewParts('a', 'a/b')).toEqual({ newLevel: 1, parts: ['b'] })
    expect(findNewParts('a/b', 'a/b/c')).toEqual({ newLevel: 2, parts: ['c'] })
  })

  it('restarts at the root for a sibling branch', () => {
    expect(findNewParts('a/b', 'c')).toEqual({ newLevel: 0, parts: ['c'] })
  })

  it('reports nothing new when the directory is unchanged', () => {
    expect(findNewParts('a/b', 'a/b')).toEqual({ newLevel: 2, parts: [] })
  })
})

describe('buildLevel / readLevel', () => {
  it('indents two spaces per level', () => {
    expect(buildLevel(0)).toBe('')
    expect(buildLevel(1)).toBe('  ')
    expect(buildLevel(3)).toBe('      ')
  })

  it('never produces negative indentation', () => {
    expect(buildLevel(-2)).toBe('')
  })

  it('reads the level back out of a line', () => {
    expect(readLevel('one.txt')).toEqual({ level: 0, value: 'one.txt' })
    expect(readLevel('  one.txt')).toEqual({ level: 1, value: 'one.txt' })
    expect(readLevel('    one.txt')).toEqual({ level: 2, value: 'one.txt' })
  })

  it('round-trips with buildLevel', () => {
    for (const level of [0, 1, 2, 5]) {
      expect(readLevel(`${buildLevel(level)}x`)).toEqual({ level, value: 'x' })
    }
  })
})

describe('normalizeDirectory', () => {
  it('drops trailing separators', () => {
    expect(normalizeDirectory('a/')).toBe('a')
    expect(normalizeDirectory('a/b//')).toBe('a/b')
  })

  it('maps the root to a single dot', () => {
    expect(normalizeDirectory('./')).toBe('.')
    expect(normalizeDirectory('/')).toBe('.')
  })
})

describe('resolveDestination', () => {
  it('joins the destination root with a listing entry', () => {
    expect(resolveDestination('out', 'a/b.txt')).toBe(path.join('out', 'a', 'b.txt'))
  })

  it('defaults to the working directory', () => {
    expect(resolveDestination(undefined, 'a.txt')).toBe('a.txt')
  })

  it('keeps an absolute destination absolute', () => {
    const root = path.resolve('out')
    expect(resolveDestination(root, 'a/b.txt')).toBe(path.join(root, 'a', 'b.txt'))
  })
})
