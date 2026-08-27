import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { CONFLICT_STRATEGIES } from '../src/constants.js'
import { findNonExistingFilename, parseMoveList, resolveTarget } from '../src/move.js'
import { makeTempTree, removeTree } from './helpers.js'

const moves = (content) => parseMoveList(content)
  .filter((operation) => operation.type === 'move')
  .map((operation) => operation.relative)

describe('parseMoveList: the files listing', () => {
  it('takes each line as a full destination path', () => {
    expect(moves('root.txt\na/two.txt\na/b/one.txt\n')).toEqual([
      'root.txt',
      'a/two.txt',
      'a/b/one.txt'
    ])
  })
})

describe('parseMoveList: the tree listing', () => {
  it('resolves each entry against the header above it', () => {
    const content = [
      'root.txt',
      'a/',
      '  two.txt',
      '  b/',
      '    one.txt',
      'c/',
      '  three.txt'
    ].join('\n')

    expect(moves(content)).toEqual([
      'root.txt',
      'a/two.txt',
      'a/b/one.txt',
      'c/three.txt'
    ])
  })

  it('steps back out of a sub-directory when the indentation does', () => {
    // The entry that matters is 'two.txt': it sits at level 1, so it belongs to
    // 'a', not to the deeper 'a/b' that was opened just above it.
    const content = [
      'a/',
      '  b/',
      '    one.txt',
      '  two.txt'
    ].join('\n')

    expect(moves(content)).toEqual(['a/b/one.txt', 'a/two.txt'])
  })

  it('unwinds several levels at once', () => {
    const content = [
      'a/',
      '  b/',
      '    c/',
      '      deep.txt',
      '  shallow.txt',
      'top.txt'
    ].join('\n')

    expect(moves(content)).toEqual(['a/b/c/deep.txt', 'a/shallow.txt', 'top.txt'])
  })
})

describe('parseMoveList: the flat tree listing', () => {
  it('reads the full path from each header', () => {
    const content = [
      './',
      '  root.txt',
      'a/',
      '  two.txt',
      'a/b/',
      '  one.txt'
    ].join('\n')

    expect(moves(content)).toEqual(['root.txt', 'a/two.txt', 'a/b/one.txt'])
  })
})

describe('parseMoveList: delete entries', () => {
  it('recognises a flush-left marker', () => {
    expect(parseMoveList('[DEL] junk.tmp\n')).toEqual([
      { type: 'delete', target: 'junk.tmp' }
    ])
  })

  it('recognises an indented marker, as a tree listing produces', () => {
    const content = [
      'a/',
      '  keep.txt',
      '  [DEL] junk.tmp'
    ].join('\n')

    expect(parseMoveList(content)).toEqual([
      { type: 'move', relative: 'a/keep.txt' },
      { type: 'delete', target: 'junk.tmp' }
    ])
  })

  it('keeps a path spelled out in the marker', () => {
    expect(parseMoveList('[DEL] photos/junk.tmp\n')).toEqual([
      { type: 'delete', target: 'photos/junk.tmp' }
    ])
  })

  it('ignores a marker with nothing after it', () => {
    expect(parseMoveList('[DEL]\n[DEL]   \n')).toEqual([])
  })
})

describe('parseMoveList: incidentals', () => {
  it('skips blank lines', () => {
    expect(moves('a.txt\n\n\nb.txt\n')).toEqual(['a.txt', 'b.txt'])
  })

  it('skips comments, indented ones included', () => {
    expect(moves('# a note\na/\n  # another\n  one.txt\n')).toEqual(['a/one.txt'])
  })

  it('reads a listing saved with Windows line endings', () => {
    expect(moves('a/\r\n  one.txt\r\n')).toEqual(['a/one.txt'])
  })

  it('reads a listing saved with a byte order mark', () => {
    expect(moves('\uFEFFa/\r\n  one.txt\r\n')).toEqual(['a/one.txt'])
  })

  it('returns nothing for empty content', () => {
    expect(parseMoveList('')).toEqual([])
  })
})

describe('findNonExistingFilename', () => {
  let roots = []

  afterEach(async () => {
    await removeTree(...roots)
    roots = []
  })

  async function tree (files) {
    const root = await makeTempTree(files)
    roots.push(root)
    return root
  }

  it('returns the path untouched when it is free', async () => {
    const root = await tree({})
    const target = path.join(root, 'free.txt')

    expect(findNonExistingFilename(target)).toBe(target)
  })

  it('suffixes inside the destination directory, not the working directory', async () => {
    const root = await tree({ 'keep/dup.txt': 'existing' })
    const target = path.join(root, 'keep', 'dup.txt')

    expect(findNonExistingFilename(target)).toBe(path.join(root, 'keep', 'dup-1.txt'))
  })

  it('keeps counting past names that are also taken', async () => {
    const root = await tree({
      'dup.txt': 'a',
      'dup-1.txt': 'b',
      'dup-2.txt': 'c'
    })

    expect(findNonExistingFilename(path.join(root, 'dup.txt')))
      .toBe(path.join(root, 'dup-3.txt'))
  })

  it('avoids names already claimed by the plan', async () => {
    const root = await tree({ 'dup.txt': 'a' })
    const reserved = new Set([path.resolve(root, 'dup-1.txt')])

    expect(findNonExistingFilename(path.join(root, 'dup.txt'), { reserved }))
      .toBe(path.join(root, 'dup-2.txt'))
  })

  it('keeps the extension on the suffixed name', async () => {
    const root = await tree({ 'photo.tar.gz': 'a' })

    expect(findNonExistingFilename(path.join(root, 'photo.tar.gz')))
      .toBe(path.join(root, 'photo.tar-1.gz'))
  })

  it('gives up rather than looping forever', async () => {
    const root = await tree({ 'x.txt': 'a', 'x-1.txt': 'b' })

    expect(() => findNonExistingFilename(path.join(root, 'x.txt'), { limit: 1 }))
      .toThrow(/Cannot find a free file name/)
  })
})

describe('resolveTarget', () => {
  let roots = []

  afterEach(async () => {
    await removeTree(...roots)
    roots = []
  })

  async function taken () {
    const root = await makeTempTree({ 'dup.txt': 'existing' })
    roots.push(root)
    return path.join(root, 'dup.txt')
  }

  it('reports no conflict for a free destination', async () => {
    const root = await makeTempTree({})
    roots.push(root)

    expect(resolveTarget(path.join(root, 'free.txt')))
      .toEqual({ target: path.join(root, 'free.txt'), conflict: false, action: 'create' })
  })

  it('renames by default', async () => {
    const target = await taken()
    const resolution = resolveTarget(target)

    expect(resolution.action).toBe('rename')
    expect(resolution.conflict).toBe(true)
    expect(resolution.target).toBe(target.replace('dup.txt', 'dup-1.txt'))
  })

  it('reports a skip without changing the target', async () => {
    const target = await taken()

    expect(resolveTarget(target, { onConflict: CONFLICT_STRATEGIES.skip }))
      .toEqual({ target, conflict: true, action: 'skip' })
  })

  it('reports an overwrite', async () => {
    const target = await taken()

    expect(resolveTarget(target, { onConflict: CONFLICT_STRATEGIES.overwrite }))
      .toEqual({ target, conflict: true, action: 'overwrite' })
  })

  it('reports a failure', async () => {
    const target = await taken()

    expect(resolveTarget(target, { onConflict: CONFLICT_STRATEGIES.fail }))
      .toEqual({ target, conflict: true, action: 'fail' })
  })

  it('treats a reserved name as taken even though nothing is on disk', async () => {
    const root = await makeTempTree({})
    roots.push(root)
    const target = path.join(root, 'planned.txt')

    expect(resolveTarget(target, { reserved: new Set([path.resolve(target)]) }).conflict).toBe(true)
  })

  it('rejects an unknown strategy', async () => {
    const target = await taken()

    expect(() => resolveTarget(target, { onConflict: 'nonsense' }))
      .toThrow(/Unknown conflict strategy/)
  })
})
