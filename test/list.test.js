import fsp from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { LIST_TYPES } from '../src/constants.js'
import { buildFullTree, collectFiles, listDirectory } from '../src/list.js'
import { makeTempTree, removeTree } from './helpers.js'

const SAMPLE = {
  'root.txt': 'root',
  'a/two.txt': 'two',
  'a/b/one.txt': 'one',
  'c/three.txt': 'three'
}

const SORTED = ['root.txt', 'a/two.txt', 'a/b/one.txt', 'c/three.txt']

let roots = []

async function tree (files = SAMPLE) {
  const root = await makeTempTree(files)
  roots.push(root)
  return root
}

afterEach(async () => {
  await removeTree(...roots)
  roots = []
})

describe('buildFullTree', () => {
  it('nests a tree listing by depth', () => {
    expect(buildFullTree(LIST_TYPES.tree, SORTED)).toEqual([
      'root.txt',
      'a/',
      '  two.txt',
      '  b/',
      '    one.txt',
      'c/',
      '  three.txt'
    ])
  })

  it('gives a flat tree one header per directory, always at the root', () => {
    expect(buildFullTree(LIST_TYPES.flatTree, SORTED)).toEqual([
      './',
      '  root.txt',
      'a/',
      '  two.txt',
      'a/b/',
      '  one.txt',
      'c/',
      '  three.txt'
    ])
  })

  it('produces a different layout for each tree format', () => {
    expect(buildFullTree(LIST_TYPES.tree, SORTED))
      .not.toEqual(buildFullTree(LIST_TYPES.flatTree, SORTED))
  })

  it('returns nothing for an empty listing', () => {
    expect(buildFullTree(LIST_TYPES.tree, [])).toEqual([])
  })
})

describe('collectFiles', () => {
  it('returns paths relative to the scanned directory, with slashes', async () => {
    expect(collectFiles(await tree())).toEqual(SORTED)
  })

  it('leaves the excluded file out', async () => {
    const root = await tree()
    const output = path.join(root, 'root.txt')

    expect(collectFiles(root, { exclude: output })).toEqual([
      'a/two.txt',
      'a/b/one.txt',
      'c/three.txt'
    ])
  })

  it('honours the ignore predicate', async () => {
    const root = await tree()

    expect(collectFiles(root, { isIgnored: (candidate) => candidate.startsWith('a') }))
      .toEqual(['root.txt', 'c/three.txt'])
  })

  it('returns nothing for an empty directory', async () => {
    expect(collectFiles(await tree({}))).toEqual([])
  })
})

describe('listDirectory', () => {
  it('writes one path per line for the files format', async () => {
    const root = await tree()
    const output = path.join(root, '..', `${path.basename(root)}-files`)

    const count = listDirectory(LIST_TYPES.files, root, output)

    expect(count).toBe(4)
    expect(await fsp.readFile(output, 'utf8')).toBe(`${SORTED.join('\n')}\n`)

    await removeTree(output)
  })

  it('never lists the file it is writing', async () => {
    const root = await tree()
    const output = path.join(root, 'listing.txt')

    listDirectory(LIST_TYPES.files, root, output)
    const content = await fsp.readFile(output, 'utf8')

    expect(content).not.toContain('listing.txt')
  })

  it('skips the default ignores', async () => {
    const root = await tree({
      'keep.txt': 'keep',
      '.git/config': 'git',
      'node_modules/pkg/index.js': 'nm'
    })
    const output = path.join(root, 'listing.txt')

    expect(listDirectory(LIST_TYPES.files, root, output)).toBe(1)
  })

  it('keeps them when the defaults are turned off', async () => {
    const root = await tree({
      'keep.txt': 'keep',
      '.git/config': 'git'
    })
    const output = path.join(root, 'listing.txt')

    expect(listDirectory(LIST_TYPES.files, root, output, { defaultIgnores: false })).toBe(2)
  })

  it('writes an empty file for an empty directory', async () => {
    const root = await tree({})
    const output = path.join(root, 'listing.txt')

    expect(listDirectory(LIST_TYPES.tree, root, output)).toBe(0)
    expect(await fsp.readFile(output, 'utf8')).toBe('')
  })

  it('rejects an unknown format', async () => {
    const root = await tree()

    expect(() => listDirectory('nonsense', root, path.join(root, 'out')))
      .toThrow(/Unknown list format/)
  })

  it('rejects a directory that is not there', () => {
    expect(() => listDirectory(LIST_TYPES.tree, path.join('does', 'not', 'exist'), 'out'))
      .toThrow(/does not exist/)
  })
})
