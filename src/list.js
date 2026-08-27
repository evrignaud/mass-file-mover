import fs from 'node:fs'
import path from 'node:path'

import { DELETE_MARKER, LIST_TYPES } from './constants.js'
import { buildLevel, findNewParts, sortPaths, splitDirectory, toPosix } from './paths.js'
import { isDotFimDir, walkSync } from './walk.js'

/**
 * Collects every file below `directory`, as POSIX paths relative to
 * `directory` so the listing can later be re-rooted somewhere else.
 *
 * @param {string} directory
 * @param {string} [excludedFile] Path that must be left out, typically the
 *   listing being generated.
 * @returns {string[]} Sorted relative POSIX paths.
 */
export function collectFiles (directory, excludedFile) {
  const filenames = []
  const excluded = excludedFile ? path.resolve(excludedFile) : null
  const seen = new Map()

  walkSync(directory, (basedir, filename, entry) => {
    if (entry.isDirectory() || isDotFimDir(basedir)) {
      return
    }

    const fullPath = path.join(basedir, filename)

    // Never list the output file itself.
    if (excluded && path.resolve(fullPath) === excluded) {
      return
    }

    if (filename.startsWith(DELETE_MARKER)) {
      console.log(`WARN: File '${filename}' has a name starting with the delete marker '${DELETE_MARKER}'. The move command would delete it`)
    }

    // The move command resolves entries by file name, so duplicated names
    // across directories are worth flagging while listing.
    const previous = seen.get(filename)
    if (previous) {
      console.log(`WARN: File '${filename}' found several times: '${toPosix(previous)}' and '${toPosix(fullPath)}'`)
    } else {
      seen.set(filename, fullPath)
    }

    filenames.push(toPosix(path.relative(directory, fullPath)))
  })

  return sortPaths(filenames)
}

/**
 * Walks `directory` and writes the discovered files to `fileList` using the
 * layout selected by `listType`.
 *
 * @param {string} listType One of {@link LIST_TYPES}.
 * @param {string} [directory]
 * @param {string} [fileList]
 * @returns {number} Number of files written.
 */
export function listDirectory (listType, directory = '.', fileList = 'fileList') {
  if (!Object.values(LIST_TYPES).includes(listType)) {
    throw new Error(`Unknown list type '${listType}'`)
  }

  const filenames = collectFiles(directory, fileList)

  const lines = listType === LIST_TYPES.files
    ? filenames
    : buildFullTree(listType, filenames)

  fs.writeFileSync(fileList, lines.length ? `${lines.join('\n')}\n` : '')

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
