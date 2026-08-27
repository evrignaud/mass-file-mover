import fsp from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { run } from '../src/cli.js'
import { makeTempDir, readTree, removeTree, writeListing } from './helpers.js'

const SAMPLE = {
  'root.txt': 'root',
  'a/two.txt': 'two'
}

let roots = []
let stdout = []
let stderr = []

/**
 * Invokes the CLI the way a shell would, minus the node and script argv slots.
 *
 * @param {...string} args
 * @returns {Promise<number>} Exit code.
 */
const cli = (...args) => run(['node', 'mass-file-mover', ...args])

async function scenario (files = SAMPLE) {
  const root = await makeTempDir()
  roots.push(root)

  const source = path.join(root, 'src')
  await fsp.mkdir(source, { recursive: true })
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(source, ...relative.split('/'))
    await fsp.mkdir(path.dirname(full), { recursive: true })
    await fsp.writeFile(full, content)
  }

  return {
    root,
    source,
    destination: path.join(root, 'out'),
    listing: path.join(root, 'plan'),
    journal: path.join(root, 'undo.json')
  }
}

beforeEach(() => {
  stdout = []
  stderr = []
  vi.spyOn(console, 'log').mockImplementation((line) => stdout.push(String(line)))
  vi.spyOn(console, 'error').mockImplementation((line) => stderr.push(String(line)))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await removeTree(...roots)
  roots = []
})

describe('run: list', () => {
  it('writes a tree listing by default', async () => {
    const { source, listing } = await scenario()

    expect(await cli('list', source, '-o', listing)).toBe(0)
    expect(await fsp.readFile(listing, 'utf8')).toBe('root.txt\na/\n  two.txt\n')
  })

  it('honours the requested format', async () => {
    const { source, listing } = await scenario()

    expect(await cli('list', source, '-o', listing, '-f', 'files')).toBe(0)
    expect(await fsp.readFile(listing, 'utf8')).toBe('root.txt\na/two.txt\n')
  })

  it('still accepts the original command names and positional arguments', async () => {
    const { source, listing } = await scenario()

    expect(await cli('list-files', source, listing)).toBe(0)
    expect(await fsp.readFile(listing, 'utf8')).toBe('root.txt\na/two.txt\n')
  })

  it('applies an ignore pattern', async () => {
    const { source, listing } = await scenario({ 'keep.txt': 'a', 'skip.log': 'b' })

    expect(await cli('list', source, '-o', listing, '-i', '*.log', '-f', 'files')).toBe(0)
    expect(await fsp.readFile(listing, 'utf8')).toBe('keep.txt\n')
  })

  it('prints a parseable document with --json, and nothing else on stdout', async () => {
    const { source, listing } = await scenario()

    expect(await cli('list', source, '-o', listing, '--json')).toBe(0)

    const payload = JSON.parse(stdout.join('\n'))
    expect(payload).toMatchObject({
      format: 'tree',
      directory: source,
      count: 2,
      files: ['root.txt', 'a/two.txt']
    })
  })
})

describe('run: move', () => {
  it('applies a listing and reports success', async () => {
    const { source, destination, listing } = await scenario()
    await writeListing(listing, ['archive/', '  root.txt', '  two.txt'])

    expect(await cli('move', listing, source, destination)).toBe(0)
    expect(await readTree(destination)).toEqual({
      'archive/root.txt': 'root',
      'archive/two.txt': 'two'
    })
  })

  it('exits non-zero when the listing names something missing', async () => {
    const { source, destination, listing } = await scenario()
    await writeListing(listing, ['root.txt', 'ghost.txt'])

    expect(await cli('move', listing, source, destination)).toBe(1)
  })

  it('changes nothing with --dry-run', async () => {
    const { source, destination, listing } = await scenario()
    await writeListing(listing, ['archive/', '  root.txt'])

    expect(await cli('move', listing, source, destination, '--dry-run')).toBe(0)
    expect(await readTree(source)).toEqual(SAMPLE)
    await expect(fsp.stat(destination)).rejects.toThrow()
  })

  it('leaves the source in place with --copy', async () => {
    const { source, destination, listing } = await scenario()
    await writeListing(listing, ['root.txt'])

    expect(await cli('move', listing, source, destination, '--copy')).toBe(0)
    expect(await readTree(source)).toEqual(SAMPLE)
    expect(await readTree(destination)).toEqual({ 'root.txt': 'root' })
  })

  it('exits non-zero with --on-conflict fail', async () => {
    const { source, destination, listing } = await scenario({ 'dup.txt': 'INCOMING' })
    await fsp.mkdir(destination, { recursive: true })
    await fsp.writeFile(path.join(destination, 'dup.txt'), 'EXISTING')
    await writeListing(listing, ['dup.txt'])

    expect(await cli('move', listing, source, destination, '--on-conflict', 'fail')).toBe(1)
    expect(await readTree(destination)).toEqual({ 'dup.txt': 'EXISTING' })
  })

  it('keeps stdout free of log lines when --json is used', async () => {
    const { source, destination, listing } = await scenario()
    await writeListing(listing, ['root.txt'])

    expect(await cli('move', listing, source, destination, '--json')).toBe(0)
    expect(() => JSON.parse(stdout.join('\n'))).not.toThrow()
    expect(stderr.join('\n')).toContain('root.txt')
  })
})

describe('run: undo', () => {
  it('walks a recorded run back', async () => {
    const { source, destination, listing, journal } = await scenario()
    await writeListing(listing, ['archive/', '  root.txt', '  two.txt'])

    expect(await cli('move', listing, source, destination, '--journal', journal)).toBe(0)
    expect(await cli('undo', journal)).toBe(0)

    expect(await readTree(source)).toEqual(SAMPLE)
    expect(await readTree(destination)).toEqual({})
  })

  it('changes nothing on a dry run', async () => {
    const { source, destination, listing, journal } = await scenario()
    await writeListing(listing, ['archive/', '  root.txt'])

    await cli('move', listing, source, destination, '--journal', journal)
    const before = await readTree(destination)

    expect(await cli('undo', journal, '--dry-run')).toBe(0)
    expect(await readTree(destination)).toEqual(before)
  })

  it('rejects a file that is not a journal', async () => {
    const { root } = await scenario()
    const notAJournal = path.join(root, 'nope.json')
    await fsp.writeFile(notAJournal, '{}')

    await expect(cli('undo', notAJournal)).rejects.toThrow(/not a mass-file-mover journal/)
  })
})

describe('run: no arguments', () => {
  it('prints the help and reports a failure', async () => {
    // Commander writes help straight to the stream, not through console.
    const written = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk))
      return true
    })

    const code = await run(['node', 'mass-file-mover'])

    expect(code).toBe(1)
    expect(written.join('')).toContain('Usage: mass-file-mover')
  })
})
