import { describe, expect, it } from 'vitest'

import { createIgnoreMatcher, DEFAULT_IGNORES, expandPattern } from '../src/ignore.js'

describe('expandPattern', () => {
  it('lets a bare name match at any depth, and everything below it', () => {
    expect(expandPattern('node_modules')).toEqual([
      'node_modules',
      'node_modules/**',
      '**/node_modules',
      '**/node_modules/**'
    ])
  })

  it('keeps a pattern with a separator anchored at the root', () => {
    expect(expandPattern('docs/drafts')).toEqual(['docs/drafts', 'docs/drafts/**'])
  })

  it('tolerates a leading ./ and a trailing /', () => {
    // Once stripped this is a bare name, so it stays depth-independent.
    expect(expandPattern('./build/')).toEqual([
      'build',
      'build/**',
      '**/build',
      '**/build/**'
    ])
  })

  it('produces nothing for an empty pattern', () => {
    expect(expandPattern('')).toEqual([])
    expect(expandPattern('   ')).toEqual([])
  })
})

describe('createIgnoreMatcher', () => {
  it('skips the default directories and their contents', () => {
    const isIgnored = createIgnoreMatcher()

    for (const name of DEFAULT_IGNORES) {
      expect(isIgnored(name)).toBe(true)
      expect(isIgnored(`${name}/nested/file.txt`)).toBe(true)
      expect(isIgnored(`deep/inside/${name}/file.txt`)).toBe(true)
    }
  })

  it('keeps ordinary files', () => {
    const isIgnored = createIgnoreMatcher()

    expect(isIgnored('a/two.txt')).toBe(false)
    expect(isIgnored('root.txt')).toBe(false)
    expect(isIgnored('gitignore.txt')).toBe(false)
  })

  it('matches nothing once the defaults are turned off', () => {
    const isIgnored = createIgnoreMatcher([], { useDefaults: false })

    expect(isIgnored('.git/config')).toBe(false)
    expect(isIgnored('node_modules/pkg/index.js')).toBe(false)
    expect(isIgnored.patterns).toEqual([])
  })

  it('applies a glob at any depth', () => {
    const isIgnored = createIgnoreMatcher(['*.log'], { useDefaults: false })

    expect(isIgnored('debug.log')).toBe(true)
    expect(isIgnored('a/b/debug.log')).toBe(true)
    expect(isIgnored('debug.txt')).toBe(false)
  })

  it('anchors a pattern that carries a separator', () => {
    const isIgnored = createIgnoreMatcher(['docs/drafts'], { useDefaults: false })

    expect(isIgnored('docs/drafts')).toBe(true)
    expect(isIgnored('docs/drafts/note.md')).toBe(true)
    expect(isIgnored('other/docs/drafts/note.md')).toBe(false)
  })

  it('matches dot files, which globs normally leave out', () => {
    const isIgnored = createIgnoreMatcher(['.cache'], { useDefaults: false })

    expect(isIgnored('.cache/entry')).toBe(true)
  })

  it('combines the defaults with the patterns it is given', () => {
    const isIgnored = createIgnoreMatcher(['*.tmp'])

    expect(isIgnored('.git')).toBe(true)
    expect(isIgnored('scratch.tmp')).toBe(true)
    expect(isIgnored.patterns).toEqual([...DEFAULT_IGNORES, '*.tmp'])
  })
})
