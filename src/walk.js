import fs from 'node:fs'
import path from 'node:path'

import { toPosix } from './paths.js'

/**
 * Synchronously lists the files below `dir`, calling `iterator` for each one.
 *
 * Directory entries are read with their types, so symbolic links are reported
 * as links and are never descended into. That keeps a link pointing back at an
 * ancestor from sending the walk into an endless loop.
 *
 * Directories are only queued when they pass `isIgnored`, so an ignored
 * directory is skipped whole instead of being read and filtered entry by entry.
 *
 * @param {string} dir Root of the walk.
 * @param {(entry: {
 *   basedir: string,
 *   filename: string,
 *   fullPath: string,
 *   relativePath: string,
 *   dirent: fs.Dirent
 * }) => void} iterator Called for every entry that is not a directory.
 * @param {object} [options]
 * @param {(relativePath: string) => boolean} [options.isIgnored]
 * @param {{ error: (message: string) => void, debug: (message: string) => void }} [options.logger]
 */
export function walkSync (dir, iterator, { isIgnored, logger } = {}) {
  const queue = [dir]

  while (queue.length) {
    const directory = queue.shift()

    let entries
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch (error) {
      logger?.error(`Cannot read directory ${directory}: ${error.message}`)
      continue
    }

    for (const dirent of entries) {
      const fullPath = path.join(directory, dirent.name)
      const relativePath = toPosix(path.relative(dir, fullPath))

      if (isIgnored?.(relativePath)) {
        logger?.debug(`Ignored '${relativePath}'`)
        continue
      }

      if (dirent.isDirectory()) {
        queue.push(fullPath)
        continue
      }

      iterator({
        basedir: directory,
        filename: dirent.name,
        fullPath,
        relativePath,
        dirent
      })
    }
  }
}
