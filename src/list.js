import fs from 'node:fs'
import path from 'node:path'

import { DELETE_MARKER, LIST_TYPES } from './constants.js'
import { createIgnoreMatcher } from './ignore.js'
import { silentLogger } from './logger.js'
import { buildLevel, findNewParts, sortPaths, splitDirectory } from './paths.js'
import { walkSync } from './walk.js'

/**
 * Collects every file below `directory`, as POSIX paths relative to
 * `directory` so the listing can later be re-rooted somewhere else.
 *
 * @param {string} directory
 * @param {object} [options]
 * @param {string} [options.exclude] Path to leave out, typically the listing
 *   being generated.
 * @param {(relativePath: string) => boolean} [options.isIgnored]
 * @param {object} [options.logger]
 * @returns {string[]} Sorted relative POSIX paths.
 */
export function collectFiles (directory, { exclude, isIgnored, logger = silentLogger } = {}) {
  const filenames = []
  const excluded = exclude ? path.resolve(exclude) : null
  const seen = new Map()

  walkSync(directory, ({ filename, fullPath, relativePath }) => {
    // Never list the output file itself.
    if (excluded && path.resolve(fullPath) === excluded) {
      return
    }

    if (filename.startsWith(DELETE_MARKER)) {
      logger.warn(`File '${relativePath}' starts with the delete marker '${DELETE_MARKER}'. The move command would delete it`)
    }

    // The move command resolves entries by file name, so duplicated names
    // across directories are worth flagging while listing.
    const previous = seen.get(filename)
    if (previous) {
      logger.warn(`File '${filename}' found several times: '${previous}' and '${relativePath}'`)
    } else {
      seen.set(filename, relativePath)
    }

    filenames.push(relativePath)
  }, { isIgnored, logger })

  return sortPaths(filenames)
}

/**
 * Walks `directory` and writes the discovered files to `output` using the
 * layout selected by `listType`.
 *
 * @param {string} listType One of {@link LIST_TYPES}.
 * @param {string} [directory]
 * @param {string} [output]
 * @param {object} [options]
 * @param {string[]} [options.ignore]
 * @param {boolean} [options.defaultIgnores]
 * @param {object} [options.logger]
 * @returns {number} Number of files written.
 */
export function listDirectory (listType, directory = '.', output = 'fileList', options = {}) {
  if (!Object.values(LIST_TYPES).includes(listType)) {
    throw new Error(`Unknown list format '${listType}'. Expected one of ${Object.values(LIST_TYPES).join(', ')}`)
  }

  if (!fs.existsSync(directory)) {
    throw new Error(`Directory '${directory}' does not exist`)
  }

  const { ignore = [], defaultIgnores = true, logger = silentLogger } = options
  const isIgnored = createIgnoreMatcher(ignore, { useDefaults: defaultIgnores })

  logger.debug(`Ignoring: ${isIgnored.patterns.join(', ') || '(nothing)'}`)

  const filenames = collectFiles(directory, { exclude: output, isIgnored, logger })

  const lines = listType === LIST_TYPES.files
    ? filenames
    : buildFullTree(listType, filenames)

  fs.writeFileSync(output, lines.length ? `${lines.join('\n')}\n` : '')

  return filenames.length
}

/**
 * Builds a listing that carries the directory structure, either as flat
 * `directory/` headers or as an indented tree.
 *
 * @param {string} listType
 * @param {string[]} filenames Relative POSIX paths, sorted.
 * @returns {string[]} Lines, without trailing newlines.
 */
export function buildFullTree (listType, filenames) {
  const flat = listType === LIST_TYPES.flatTree
  const lines = []
  let currentDirectory = null

  for (const filename of filenames) {
    const directory = path.posix.dirname(filename)

    if (directory !== currentDirectory) {
      if (flat) {
        lines.push(`${directory}/`)
      } else {
        const { newLevel, parts } = findNewParts(currentDirectory ?? '', directory)
        let headerLevel = newLevel
        for (const part of parts) {
          lines.push(`${buildLevel(headerLevel)}${part}/`)
          headerLevel++
        }
      }
      currentDirectory = directory
    }

    // A flat tree always indents by one, a nested tree by its depth.
    const level = flat ? 1 : splitDirectory(directory).length
    lines.push(`${buildLevel(level)}${path.posix.basename(filename)}`)
  }

  return lines
}
