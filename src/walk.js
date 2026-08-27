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
  return directory.includes('.fim/') || directory.endsWith('.fim')
}

/**
 * Synchronously lists `dir` and all its descendants, calling `iterator`
 * for each entry.
 *
 * @param {string} dir Path to the base directory of the listing.
 * @param {(basedir: string, filename: string, stat: fs.Stats) => void} iterator
 *   Called for each entry with:
 *   - `basedir`: directory holding the entry (relative to `dir`)
 *   - `filename`: name of the entry
 *   - `stat`: result of `fs.statSync`
 */
export function walkSync (dir, iterator) {
  const dirs = [dir]

  while (dirs.length) {
    const directory = dirs.shift()

    let files
    try {
      files = fs.readdirSync(directory)
    } catch (error) {
      console.error(`ERR: Cannot read directory ${directory}`, error.message)
      continue
    }

    for (const file of files) {
      const fullPath = path.join(directory, file)
      let stat
      try {
        stat = fs.statSync(fullPath)
        if (stat && stat.isDirectory()) {
          dirs.push(fullPath)
        }
      } catch (error) {
        console.error(`ERR: Cannot stat ${fullPath}`, error.message)
      }

      if (stat) {
        iterator(directory, file, stat)
      }
    }
  }
}
