import fsp from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { CONFLICT_STRATEGIES, LIST_TYPES, TRANSFER_MODES } from '../src/constants.js'
import { listDirectory } from '../src/list.js'
import { moveFiles } from '../src/move.js'
import {
  makeTempDir,
  readDirectories,
  readTree,
  removeTree,
  writeListing
} from './helpers.js'

const SAMPLE = {
  'root.txt': 'root',
  'a/two.txt': 'two',
  'a/b/one.txt': 'one',
  'c/three.txt': 'three'
}

let roots = []

/**
 * Builds a source tree, a destination directory and a listing file, all inside
 * one temp root so a single cleanup covers everything.
 */
async function scenario (files = SAMPLE, lines = []) {
  const root = await makeTempDir()
  roots.push(root)

  const source = path.join(root, 'src')
  const destination = path.join(root, 'out')
  const listing = path.join(root, 'plan')

  await fsp.mkdir(source, { recursive: true })
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(source, ...relative.split('/'))
    await fsp.mkdir(path.dirname(full), { recursive: true })
    await fsp.writeFile(full, content)
  }

  if (lines.length) {
    await writeListing(listing, lines)
  }

  return { root, source, destination, listing }
}

afterEach(async () => {
  await removeTree(...roots)
  roots = []
})

describe('moveFiles: applying a listing produced by list', () => {
  for (const format of Object.values(LIST_TYPES)) {
    it(`rebuilds the same tree from a ${format} listing`, async () => {
      const { source, destination, listing } = await scenario()

      listDirectory(format, source, listing)
      const summary = await moveFiles(listing, source, destination)

      expect(summary.moved).toBe(4)
      expect(summary.failed).toBe(0)
      expect(summary.missing).toBe(0)
      expect(await readTree(destination)).toEqual(SAMPLE)
    })
  }
})

describe('moveFiles: rearranging', () => {
  it('moves entries under the directory they are written below', async () => {
    const { source, destination, listing } = await scenario(SAMPLE, [
      'archive/',
      '  root.txt',
      '  deep/',
      '    one.txt',
      '  two.txt',
      'three.txt'
    ])

    await moveFiles(listing, source, destination)

    expect(await readTree(destination)).toEqual({
      'archive/root.txt': 'root',
      'archive/deep/one.txt': 'one',
      'archive/two.txt': 'two',
      'three.txt': 'three'
    })
  })

  it('cannot rename: an entry is matched to a source by its file name', async () => {
    // The listing has no source-to-destination pairing, so a file is located by
    // the name written in the entry. Changing that name does not rename the
    // file, it asks for one that is not there.
    const { source, destination, listing } = await scenario(
      { 'one.txt': 'one' },
      ['renamed.txt']
    )

    const summary = await moveFiles(listing, source, destination)

    expect(summary.moved).toBe(0)
    expect(summary.missing).toBe(1)
    expect(await readTree(source)).toEqual({ 'one.txt': 'one' })
  })

  it('changes only the directory an entry lives in', async () => {
    const { source, destination, listing } = await scenario(
      { 'deep/one.txt': 'one' },
      ['elsewhere/', '  one.txt']
    )

    await moveFiles(listing, source, destination)

    expect(await readTree(destination)).toEqual({ 'elsewhere/one.txt': 'one' })
  })

  it('finds a file wherever it sits in the source tree', async () => {
    const { source, destination, listing } = await scenario(
      { 'deeply/nested/here/one.txt': 'one' },
      ['flat.txt', 'one.txt']
    )

    await moveFiles(listing, source, destination)

    expect(await readTree(destination)).toEqual({ 'one.txt': 'one' })
  })

  it('carries every extension sharing a stem when the entry has none', async () => {
    const { source, destination, listing } = await scenario(
      { 'photos/IMG_0042.jpg': 'jpeg', 'photos/IMG_0042.raw': 'raw' },
      ['sorted/', '  IMG_0042']
    )

    await moveFiles(listing, source, destination)

    expect(await readTree(destination)).toEqual({
      'sorted/IMG_0042.jpg': 'jpeg',
      'sorted/IMG_0042.raw': 'raw'
    })
  })

  it('leaves a file alone when the listing puts it back where it is', async () => {
    const { source, listing } = await scenario({ 'one.txt': 'one' }, ['one.txt'])

    const summary = await moveFiles(listing, source, source)

    expect(summary.moved).toBe(0)
    expect(summary.unchanged).toBe(1)
    expect(await readTree(source)).toEqual({ 'one.txt': 'one' })
  })
})

describe('moveFiles: deleting', () => {
  it('removes an entry flagged with the marker', async () => {
    const { source, destination, listing } = await scenario(
      { 'keep.txt': 'keep', 'junk.tmp': 'junk' },
      ['keep.txt', '[DEL] junk.tmp']
    )

    const summary = await moveFiles(listing, source, destination)

    expect(summary.deleted).toBe(1)
    expect(await readTree(destination)).toEqual({ 'keep.txt': 'keep' })
    expect(await readTree(source)).toEqual({})
  })

  it('finds the file to delete wherever it sits', async () => {
    const { source, destination, listing } = await scenario(
      { 'keep.txt': 'keep', 'deep/nested/junk.tmp': 'junk' },
      ['keep.txt', '  [DEL] junk.tmp']
    )

    const summary = await moveFiles(listing, source, destination)

    expect(summary.deleted).toBe(1)
    expect(summary.failed).toBe(0)
  })

  it('reports a delete entry naming nothing that exists', async () => {
    const { source, destination, listing } = await scenario(
      { 'keep.txt': 'keep' },
      ['keep.txt', '[DEL] ghost.tmp']
    )

    const summary = await moveFiles(listing, source, destination)

    expect(summary.missing).toBe(1)
  })
})

describe('moveFiles: pruning', () => {
  it('removes source directories left empty, keeping the root', async () => {
    const { source, destination, listing } = await scenario(SAMPLE, [
      'root.txt',
      'two.txt',
      'one.txt',
      'three.txt'
    ])

    await moveFiles(listing, source, destination)

    expect(await readDirectories(source)).toEqual([])
    await expect(fsp.stat(source)).resolves.toBeDefined()
  })

  it('keeps them when pruning is turned off', async () => {
    const { source, destination, listing } = await scenario(SAMPLE, [
      'root.txt',
      'two.txt',
      'one.txt',
      'three.txt'
    ])

    await moveFiles(listing, source, destination, { prune: false })

    expect(await readDirectories(source)).toEqual(['a', 'a/b', 'c'])
  })
})

describe('moveFiles: conflicts', () => {
  async function conflict (onConflict) {
    const { source, destination, listing } = await scenario(
      { 'dup.txt': 'INCOMING' },
      ['dup.txt']
    )
    await fsp.mkdir(destination, { recursive: true })
    await fsp.writeFile(path.join(destination, 'dup.txt'), 'EXISTING')

    const summary = await moveFiles(listing, source, destination, { onConflict })

    return { summary, destination, source }
  }

  it('renames the incoming file by default', async () => {
    const { summary, destination } = await conflict(CONFLICT_STRATEGIES.rename)

    expect(summary.conflicts).toBe(1)
    expect(await readTree(destination)).toEqual({
      'dup.txt': 'EXISTING',
      'dup-1.txt': 'INCOMING'
    })
  })

  it('leaves both sides alone when skipping', async () => {
    const { summary, destination, source } = await conflict(CONFLICT_STRATEGIES.skip)

    expect(summary.skipped).toBe(1)
    expect(summary.moved).toBe(0)
    expect(await readTree(destination)).toEqual({ 'dup.txt': 'EXISTING' })
    expect(await readTree(source)).toEqual({ 'dup.txt': 'INCOMING' })
  })

  it('replaces the destination when overwriting', async () => {
    const { summary, destination } = await conflict(CONFLICT_STRATEGIES.overwrite)

    expect(summary.moved).toBe(1)
    expect(await readTree(destination)).toEqual({ 'dup.txt': 'INCOMING' })
  })

  it('reports a failure and changes nothing when failing', async () => {
    const { summary, destination, source } = await conflict(CONFLICT_STRATEGIES.fail)

    expect(summary.missing).toBe(1)
    expect(summary.moved).toBe(0)
    expect(await readTree(destination)).toEqual({ 'dup.txt': 'EXISTING' })
    expect(await readTree(source)).toEqual({ 'dup.txt': 'INCOMING' })
  })

  it('gives two sources of the same name distinct destinations', async () => {
    const { source, destination, listing } = await scenario(
      { 'a/dup.txt': 'from-a', 'b/dup.txt': 'from-b' },
      ['merged/', '  dup.txt']
    )

    await moveFiles(listing, source, destination)

    expect(await readTree(destination)).toEqual({
      'merged/dup.txt': 'from-a',
      'merged/dup-1.txt': 'from-b'
    })
  })
})

describe('moveFiles: copy mode', () => {
  it('leaves the source tree exactly as it was', async () => {
    const { source, destination, listing } = await scenario(SAMPLE, [
      'archive/',
      '  root.txt',
      '  one.txt'
    ])

    const summary = await moveFiles(listing, source, destination, {
      mode: TRANSFER_MODES.copy
    })

    expect(summary.copied).toBe(2)
    expect(summary.moved).toBe(0)
    expect(await readTree(source)).toEqual(SAMPLE)
    expect(await readTree(destination)).toEqual({
      'archive/root.txt': 'root',
      'archive/one.txt': 'one'
    })
  })

  it('does not delete a file flagged with the marker', async () => {
    const { source, destination, listing } = await scenario(
      { 'keep.txt': 'keep', 'junk.tmp': 'junk' },
      ['keep.txt', '[DEL] junk.tmp']
    )

    const summary = await moveFiles(listing, source, destination, {
      mode: TRANSFER_MODES.copy
    })

    expect(summary.deleted).toBe(0)
    expect(await readTree(source)).toEqual({ 'keep.txt': 'keep', 'junk.tmp': 'junk' })
  })

  it('never prunes the source, even when asked to', async () => {
    const { source, destination, listing } = await scenario(SAMPLE, ['one.txt'])

    await moveFiles(listing, source, destination, {
      mode: TRANSFER_MODES.copy,
      prune: true
    })

    expect(await readDirectories(source)).toEqual(['a', 'a/b', 'c'])
  })
})

describe('moveFiles: dry run', () => {
  it('reports the plan and changes nothing', async () => {
    const { source, destination, listing } = await scenario(SAMPLE, [
      'archive/',
      '  root.txt',
      '  one.txt'
    ])

    const summary = await moveFiles(listing, source, destination, { dryRun: true })

    expect(summary.dryRun).toBe(true)
    expect(summary.moved).toBe(2)
    expect(await readTree(source)).toEqual(SAMPLE)
    await expect(fsp.stat(destination)).rejects.toThrow()
  })

  it('counts the deletions it would make without making them', async () => {
    const { source, destination, listing } = await scenario(
      { 'keep.txt': 'keep', 'junk.tmp': 'junk' },
      ['keep.txt', '[DEL] junk.tmp']
    )

    const summary = await moveFiles(listing, source, destination, { dryRun: true })

    expect(summary.deleted).toBe(1)
    expect(await readTree(source)).toEqual({ 'keep.txt': 'keep', 'junk.tmp': 'junk' })
  })
})

describe('moveFiles: reporting and validation', () => {
  it('reports an entry that names nothing in the source', async () => {
    const { source, destination, listing } = await scenario(
      { 'real.txt': 'real' },
      ['real.txt', 'ghost.txt']
    )

    const summary = await moveFiles(listing, source, destination)

    expect(summary.moved).toBe(1)
    expect(summary.missing).toBe(1)
  })

  it('records what it did, ready for the journal', async () => {
    const { source, destination, listing } = await scenario(
      { 'one.txt': 'one' },
      ['archive/', '  one.txt']
    )

    const summary = await moveFiles(listing, source, destination)

    expect(summary.operations).toEqual([
      {
        type: 'move',
        from: path.join(source, 'one.txt'),
        to: path.join(destination, 'archive', 'one.txt')
      }
    ])
  })

  it('honours the ignore patterns', async () => {
    const { source, destination, listing } = await scenario(
      { 'keep.txt': 'keep', 'skip.log': 'log' },
      ['keep.txt', 'skip.log']
    )

    const summary = await moveFiles(listing, source, destination, { ignore: ['*.log'] })

    expect(summary.moved).toBe(1)
    expect(summary.missing).toBe(1)
    expect(await readTree(source)).toEqual({ 'skip.log': 'log' })
  })

  it('rejects a listing that is not there', async () => {
    const { source, destination } = await scenario()

    await expect(moveFiles(path.join(source, 'nope'), source, destination))
      .rejects.toThrow(/does not exist/)
  })

  it('rejects a source directory that is not there', async () => {
    const { root, destination, listing } = await scenario(SAMPLE, ['root.txt'])

    await expect(moveFiles(listing, path.join(root, 'nope'), destination))
      .rejects.toThrow(/does not exist/)
  })

  it('rejects an unknown conflict strategy', async () => {
    const { source, destination, listing } = await scenario(SAMPLE, ['root.txt'])

    await expect(moveFiles(listing, source, destination, { onConflict: 'nonsense' }))
      .rejects.toThrow(/Unknown conflict strategy/)
  })

  it('rejects an unknown transfer mode', async () => {
    const { source, destination, listing } = await scenario(SAMPLE, ['root.txt'])

    await expect(moveFiles(listing, source, destination, { mode: 'teleport' }))
      .rejects.toThrow(/Unknown transfer mode/)
  })
})
