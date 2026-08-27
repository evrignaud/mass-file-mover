import fs from 'node:fs'
import path from 'node:path'

/**
 * Detects the `.fim` metadata directory used by the `fim` tool, which must
 * never be listed or moved.
 *
 * @param {string} directory
 * @returns {boolean}
 */
export function isDotFimDir (directory) {
  return directory
    .split(path.sep)
    .includes('.fim')
}

/**
 * Synchronously lists `dir` and all its descendants, calling `iterator`
 * for each entry.
 *
 * Directory entries are read with their types, so symbolic links are reported
 * as links and are never descended into. That keeps a link pointing back at an
 * ancestor from sending the walk into an endless loop.
 *
 * @param {string} dir Path to the base directory of the listing.
 * @param {(basedir: string, filename: string, entry: fs.Dirent) => void} iterator
 *   Called for each entry with:
 *   - `basedir`: directory holding the entry, prefixed by `dir`
 *   - `filename`: name of the entry
 *   - `entry`: the directory entry, exposing `isDirectory()` and friends
 */
export function walkSync (dir, iterator) {
  const dirs = [dir]

  while (dirs.length) {
    const directory = dirs.shift()

    let entries
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch (error) {
      console.error(`ERR: Cannot read directory ${directory}`, error.message)
      continue
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        dirs.push(path.join(directory, entry.name))
      }

      iterator(directory, entry.name, entry)
    }
  }
}
