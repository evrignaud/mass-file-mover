import path from 'node:path'

import { INDENT_WIDTH } from './constants.js'

/**
 * Converts a native path to its POSIX form.
 *
 * Listings are always written with `/` separators so that a file list produced
 * on Windows can be replayed on Linux or macOS, and so that the indentation
 * logic of the tree layouts has a single separator to reason about.
 *
 * @param {string} filePath
 * @returns {string}
 */
export function toPosix (filePath) {
  return filePath.split(path.sep).join('/')
}

/**
 * Converts a POSIX path read back from a listing to the native form.
 *
 * @param {string} filePath
 * @returns {string}
 */
export function fromPosix (filePath) {
  return filePath.split('/').join(path.sep)
}

/**
 * Splits a POSIX directory into its meaningful segments. The scanned root is
 * written as `.` in a listing and yields an empty array.
 *
 * @param {string} directory
 * @returns {string[]}
 */
export function splitDirectory (directory) {
  if (!directory) {
    return []
  }

  return directory
    .split('/')
    .filter((part) => part !== '' && part !== '.')
}

/**
 * Case-insensitive string comparison used to order listings.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareStrings (a, b) {
  const lowerA = a.toLowerCase()
  const lowerB = b.toLowerCase()
  if (lowerA < lowerB) return -1
  if (lowerA > lowerB) return 1
  return 0
}

/**
 * Orders two split paths by directory first, then by file name, so that
 * every file of a directory stays grouped together.
 *
 * @param {{ basedir: string, filename: string }} a
 * @param {{ basedir: string, filename: string }} b
 * @returns {number}
 */
export function comparePaths (a, b) {
  if (a.basedir !== b.basedir) {
    return compareStrings(a.basedir, b.basedir)
  }

  return compareStrings(a.filename, b.filename)
}

/**
 * Sorts POSIX paths by directory, then by file name.
 *
 * @param {string[]} paths
 * @returns {string[]}
 */
export function sortPaths (paths) {
  return paths
    .map((element) => ({
      basedir: path.posix.dirname(element),
      filename: path.posix.basename(element)
    }))
    .sort(comparePaths)
    .map((element) => path.posix.join(element.basedir, element.filename))
}

/**
 * Compares the directory just written with the next one and returns how many
 * leading segments they share plus the segments that still need a header.
 *
 * @param {string} oldDirectory
 * @param {string} newDirectory
 * @returns {{ newLevel: number, parts: string[] }}
 */
export function findNewParts (oldDirectory, newDirectory) {
  const oldParts = splitDirectory(oldDirectory)
  const newParts = splitDirectory(newDirectory)
  let newLevel = 0

  while (
    newLevel < oldParts.length &&
    newLevel < newParts.length &&
    oldParts[newLevel] === newParts[newLevel]
  ) {
    newLevel++
  }

  return { newLevel, parts: newParts.slice(newLevel) }
}

/**
 * Builds the indentation prefix for the given nesting level.
 *
 * @param {number} level
 * @returns {string}
 */
export function buildLevel (level) {
  return ' '.repeat(Math.max(0, level) * INDENT_WIDTH)
}

/**
 * Returns the nesting level encoded by the leading whitespace of a listing
 * line, and the line without that indentation.
 *
 * @param {string} line
 * @returns {{ level: number, value: string }}
 */
export function readLevel (line) {
  const value = line.trimStart()
  return {
    level: Math.floor((line.length - value.length) / INDENT_WIDTH),
    value
  }
}

/**
 * Strips the trailing separators of a directory header so that the value can
 * be joined without doubling them.
 *
 * @param {string} directory
 * @returns {string}
 */
export function normalizeDirectory (directory) {
  const trimmed = directory.replace(/\/+$/, '')
  return trimmed === '' ? '.' : trimmed
}

/**
 * Resolves a listing entry against the destination root.
 *
 * @param {string} [baseDestinationDir]
 * @param {string} relativePath Relative POSIX path taken from the move list.
 * @returns {string} Native path, relative to the working directory.
 */
export function resolveDestination (baseDestinationDir = '.', relativePath) {
  return path.normalize(path.join(baseDestinationDir, fromPosix(relativePath)))
}
