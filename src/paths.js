import path from 'node:path'

import { INDENT_WIDTH } from './constants.js'

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
 * Sorts paths by directory, then by file name.
 *
 * @param {string[]} paths
 * @returns {string[]}
 */
export function sortPaths (paths) {
  return paths
    .map((element) => ({
      basedir: path.dirname(element),
      filename: path.basename(element)
    }))
    .sort(comparePaths)
    .map((element) => path.join(element.basedir, element.filename))
}

/**
 * Compares the directory just written with the next one and returns the
 * nesting level they share plus the path segments that still need a header.
 *
 * @param {string} oldDirectory
 * @param {string} newDirectory
 * @returns {{ newLevel: number, parts: string[] }}
 */
export function findNewParts (oldDirectory, newDirectory) {
  const oldParts = oldDirectory.split('/')
  const newParts = newDirectory.split('/')
  let newLevel = 0

  for (let index = 0; index < Math.min(oldParts.length, newParts.length); index++) {
    if (oldParts[index] !== newParts[index]) {
      break
    }
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
 * Resolves an indented directory header from a `tree` listing against the
 * directory that is currently open.
 *
 * @param {string} currentDirectory
 * @param {string} newPath Directory header, still carrying its indentation.
 * @returns {string}
 */
export function buildNewDirectory (currentDirectory, newPath) {
  const trimmedPath = newPath.trimStart()
  const newLevel = (newPath.length - trimmedPath.length) / INDENT_WIDTH
  const parts = currentDirectory.split('/')
  return path.join(parts.slice(0, newLevel).join('/'), trimmedPath)
}

/**
 * Turns a move list entry into its destination path. Indented entries are
 * relative to the directory header that is currently open, flush-left
 * entries already carry their own path.
 *
 * @param {string} baseDestinationDir
 * @param {string} currentDirectory
 * @param {string} newPath
 * @returns {string}
 */
export function generateFullPath (baseDestinationDir = '.', currentDirectory, newPath) {
  let fullPath = baseDestinationDir
  if (newPath.startsWith(' ')) {
    newPath = newPath.trim()
    fullPath = path.join(fullPath, currentDirectory)
  }
  return path.join(fullPath, newPath)
}
