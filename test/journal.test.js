import fsp from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { TRANSFER_MODES } from '../src/constants.js'
import { JOURNAL_VERSION, readJournal, undoJournal, writeJournal } from '../src/journal.js'
import { moveFiles } from '../src/move.js'
import { makeTempDir, readTree, removeTree, writeListing } from './helpers.js'

let roots = []

async function scenario (files, lines, { mode = TRANSFER_MODES.move } = {}) {
  const root = await makeTempDir()
  roots.push(root)

  const source = path.join(root, 'src')
  const destination = path.join(root, 'out')
  const listing = path.join(root, 'plan')
  const journalFile = path.join(root, 'undo.json')

  await fsp.mkdir(source, { recursive: true })
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(source, ...relative.split('/'))
    await fsp.mkdir(path.dirname(full), { recursive: true })
    await fsp.writeFile(full, content)
  }
  await writeListing(listing, lines)

  const summary = await moveFiles(listing, source, destination, { mode })

  await writeJournal(journalFile, {
    mode,
    directory: source,
    destination,
    operations: summary.operations,
    toolVersion: 'test'
  })

  return { root, source, destination, journalFile, summary }
}

afterEach(async () => {
  await removeTree(...roots)
  roots = []
})

describe('writeJournal / readJournal', () => {
  it('round-trips what a run did', async () => {
    const { journalFile, source, destination } = await scenario(
      { 'one.txt': 'one' },
      ['archive/', '  one.txt']
    )

    const journal = await readJournal(journalFile)

    expect(journal.version).toBe(JOURNAL_VERSION)
    expect(journal.tool).toBe('mass-file-mover')
    expect(journal.mode).toBe(TRANSFER_MODES.move)
    expect(journal.directory).toBe(source)
    expect(journal.destination).toBe(destination)
    expect(journal.operations).toEqual([
      {
        type: 'move',
        from: path.join(source, 'one.txt'),
        to: path.join(destination, 'archive', 'one.txt')
      }
    ])
    expect(Date.parse(journal.createdAt)).not.toBeNaN()
  })

  it('refuses a file that is not a journal', async () => {
    const root = await makeTempDir()
    roots.push(root)
    const file = path.join(root, 'other.json')
    await fsp.writeFile(file, JSON.stringify({ hello: 'world' }))

    await expect(readJournal(file)).rejects.toThrow(/not a mass-file-mover journal/)
  })

  it('refuses a journal written by a future version', async () => {
    const root = await makeTempDir()
    roots.push(root)
    const file = path.join(root, 'future.json')
    await fsp.writeFile(file, JSON.stringify({
      tool: 'mass-file-mover',
      version: JOURNAL_VERSION + 1,
      operations: []
    }))

    await expect(readJournal(file)).rejects.toThrow(/expected 1/)
  })

  it('refuses a journal with no operations', async () => {
    const root = await makeTempDir()
    roots.push(root)
    const file = path.join(root, 'broken.json')
    await fsp.writeFile(file, JSON.stringify({
      tool: 'mass-file-mover',
      version: JOURNAL_VERSION
    }))

    await expect(readJournal(file)).rejects.toThrow(/no operations/)
  })

  it('reports a file it cannot parse', async () => {
    const root = await makeTempDir()
    roots.push(root)
    const file = path.join(root, 'garbage.json')
    await fsp.writeFile(file, 'not json at all')

    await expect(readJournal(file)).rejects.toThrow(/Cannot read journal/)
  })
})

describe('undoJournal: after a move', () => {
  const files = { 'a/one.txt': 'one', 'two.txt': 'two' }
  const lines = ['archive/', '  one.txt', '  two.txt']

  it('puts every file back, recreating the directories that were pruned', async () => {
    const { source, destination, journalFile } = await scenario(files, lines)

    // The move emptied and pruned 'a'.
    expect(await readTree(source)).toEqual({})

    const summary = await undoJournal(await readJournal(journalFile))

    expect(summary.restored).toBe(2)
    expect(summary.failed).toBe(0)
    expect(await readTree(source)).toEqual(files)
    expect(await readTree(destination)).toEqual({})
  })

  it('changes nothing on a dry run', async () => {
    const { destination, journalFile } = await scenario(files, lines)
    const before = await readTree(destination)

    const summary = await undoJournal(await readJournal(journalFile), { dryRun: true })

    expect(summary.dryRun).toBe(true)
    expect(summary.restored).toBe(2)
    expect(await readTree(destination)).toEqual(before)
  })

  it('reports a file it cannot put back', async () => {
    const { destination, journalFile } = await scenario(files, lines)
    await fsp.rm(path.join(destination, 'archive', 'one.txt'))

    const summary = await undoJournal(await readJournal(journalFile))

    expect(summary.restored).toBe(1)
    expect(summary.failed).toBe(1)
  })
})

describe('undoJournal: after a copy', () => {
  it('removes the copies and leaves the originals alone', async () => {
    const files = { 'one.txt': 'one' }
    const { source, destination, journalFile } = await scenario(
      files,
      ['archive/', '  one.txt'],
      { mode: TRANSFER_MODES.copy }
    )

    expect(await readTree(destination)).toEqual({ 'archive/one.txt': 'one' })

    const summary = await undoJournal(await readJournal(journalFile))

    expect(summary.removed).toBe(1)
    expect(summary.restored).toBe(0)
    expect(await readTree(source)).toEqual(files)
    expect(await readTree(destination)).toEqual({})
  })
})

describe('undoJournal: what cannot be undone', () => {
  it('reports deletions instead of pretending the tree is whole', async () => {
    const summary = await undoJournal({
      mode: TRANSFER_MODES.move,
      operations: [{ type: 'delete', path: 'gone.txt' }]
    })

    expect(summary.irreversible).toBe(1)
    expect(summary.restored).toBe(0)
    expect(summary.failed).toBe(0)
  })

  it('reports an operation it does not recognise', async () => {
    const summary = await undoJournal({
      mode: TRANSFER_MODES.move,
      operations: [{ type: 'teleport' }]
    })

    expect(summary.failed).toBe(1)
  })

  it('walks operations back in reverse order', async () => {
    const root = await makeTempDir()
    roots.push(root)

    const first = path.join(root, 'first.txt')
    const second = path.join(root, 'second.txt')
    const third = path.join(root, 'third.txt')

    // A file moved twice: first -> second, then second -> third.
    await fsp.writeFile(third, 'content')

    const summary = await undoJournal({
      mode: TRANSFER_MODES.move,
      operations: [
        { type: 'move', from: first, to: second },
        { type: 'move', from: second, to: third }
      ]
    }, { prune: false })

    expect(summary.restored).toBe(2)
    expect(await fsp.readFile(first, 'utf8')).toBe('content')
  })
})
