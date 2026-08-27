import fs from 'node:fs'
import path from 'node:path'

import { DELETE_MARKER } from './constants.js'
import {
  normalizeDirectory,
  readLevel,
  resolveDestination,
  splitDirectory
} from './paths.js'
import { splitLines } from './text.js'
import { isDotFimDir, walkSync } from './walk.js'

/**
 * Indexes every file below `directory` by name and by name-without-extension
 * so a move list entry can be resolved wherever the file happens to live.
 *
 * @param {string} directory
 * @param {string} [moveList] Path of the move list, excluded from the index.
 * @returns {{ fileList: Map<string, string[]>, withoutExtList: Map<string, string[]> }}
 */
export function makeFileList (directory, moveList) {
  const fileList = new Map()
  const withoutExtList = new Map()
  const excluded = moveList ? path.resolve(moveList) : null

  walkSync(directory, (basedir, filename, entry) => {
    if (entry.isDirectory() || isDotFimDir(basedir)) {
      return
    }

    if (excluded && path.resolve(basedir, filename) === excluded) {
      return
    }

    const dirs = fileList.get(filename)
    if (dirs) {
      console.log(`WARN: File '${filename}' found several times`)
      dirs.push(basedir)
    } else {
      fileList.set(filename, [basedir])
    }

    const withoutExt = path.basename(filename, path.extname(filename))
    const variants = withoutExtList.get(withoutExt)
    if (variants) {
      if (!variants.includes(filename)) {
        variants.push(filename)
      }
    } else {
      withoutExtList.set(withoutExt, [filename])
    }
  })

  return { fileList, withoutExtList }
}

/**
 * Turns the lines of a move list into an ordered list of operations.
 *
 * Directory headers open a scope that the more deeply indented entries below
 * them belong to. Headers are tracked as a stack keyed on their indentation
 * level, so an entry that steps back out of a sub-directory lands in the right
 * place. That is what makes the three listing layouts, and hand-edited files
 * mixing them, all resolve consistently:
 *
 *     a/            level 0, opens "a"
 *       b/          level 1, opens "a/b"
 *         one.txt   level 2, inside "a/b"
 *       two.txt     level 1, back inside "a"
 *
 * Entries flagged with the delete marker become `delete` operations, which
 * name a file in the scanned tree rather than a destination path. Everything
 * else becomes a `move`.
 *
 * @param {string} content Raw content of the move list.
 * @returns {Array<{ type: 'move', relative: string } | { type: 'delete', target: string }>}
 *   `relative` is a POSIX path relative to the destination root. `target` is
 *   either a bare file name, looked up in the scanned tree, or a POSIX path
 *   relative to the scanned directory.
 */
export function parseMoveList (content) {
  const operations = []

  /** @type {Array<{ level: number, segments: string[] }>} */
  const scopes = []

  const directoryAt = (level) => scopes
    .filter((scope) => scope.level < level)
    .flatMap((scope) => scope.segments)
    .join('/')

  for (const rawLine of splitLines(content)) {
    if (!rawLine.trim()) {
      continue
    }

    // The indentation has to be read before anything else: in a tree listing
    // the delete marker and the file names are indented too.
    const { level, value } = readLevel(rawLine)

    if (value.startsWith(DELETE_MARKER)) {
      const target = value.slice(DELETE_MARKER.length).trim()
      if (target) {
        operations.push({ type: 'delete', target })
      }
      continue
    }

    if (value.endsWith('/')) {
      // Close every scope at this level or deeper, then open the new one.
      while (scopes.length && scopes.at(-1).level >= level) {
        scopes.pop()
      }
      scopes.push({ level, segments: splitDirectory(normalizeDirectory(value)) })
      continue
    }

    operations.push({
      type: 'move',
      relative: path.posix.join(directoryAt(level), value)
    })
  }

  return operations
}

/**
 * Applies a move list: every entry is moved to its new location, entries
 * flagged with the delete marker are removed, and source directories left
 * empty afterwards are pruned.
 *
 * @param {string} [moveList]
 * @param {string} [directory]
 * @param {string} [baseDestinationDir]
 */
export function moveFiles (moveList = 'fileList', directory = '.', baseDestinationDir = '.') {
  const { fileList, withoutExtList } = makeFileList(directory, moveList)
  const operations = parseMoveList(fs.readFileSync(moveList, 'utf8'))

  const alreadyMoved = new Set()
  let pending = 0

  /**
   * Removes a file flagged with the delete marker. A target holding a
   * separator is a path relative to the scanned directory; a bare name is
   * looked up in the scanned tree, exactly like a move entry, and every
   * occurrence is removed.
   *
   * @param {string} target
   */
  function deleteFromSource (target) {
    if (target.includes('/') || target.includes(path.sep)) {
      deleteFile(path.join(directory, ...target.split(/[/\\]/)))
      return
    }

    const sourceDirs = fileList.get(target)
    if (!sourceDirs) {
      console.error(`ERR: Cannot remove '${target}': no such file under '${directory}'`)
      return
    }

    for (const sourceDir of sourceDirs) {
      deleteFile(path.join(sourceDir, target))
    }
  }

  function moveFromAllDirectories (filename, destination) {
    for (const sourceDir of fileList.get(filename)) {
      const oldPath = path.join(sourceDir, filename)
      if (oldPath === destination || alreadyMoved.has(oldPath)) {
        continue
      }
      alreadyMoved.add(oldPath)

      pending++
      moveFile(oldPath, destination, (err) => {
        if (err) {
          console.log(`ERR: Error moving '${oldPath}' to '${destination}'`, err.message)
        }
        pending--
      })
    }
  }

  for (const operation of operations) {
    if (operation.type === 'delete') {
      deleteFromSource(operation.target)
      continue
    }

    const destination = resolveDestination(baseDestinationDir, operation.relative)

    // The directory has to be created at the very place the file is renamed
    // to, otherwise the rename fails with ENOENT.
    mkdirRecurs(path.dirname(destination))

    let managed = false

    const filename = path.basename(destination)
    if (fileList.has(filename)) {
      moveFromAllDirectories(filename, destination)
      managed = true
    }

    // An entry written without an extension moves every file that shares that
    // stem, each keeping its own extension.
    const variants = withoutExtList.get(filename)
    if (variants) {
      for (const withExtension of variants) {
        if (withExtension === filename) {
          continue
        }
        if (fileList.has(withExtension)) {
          moveFromAllDirectories(withExtension, destination + path.extname(withExtension))
          managed = true
        } else {
          console.log(`ERR: File '${withExtension}' does not exist`)
        }
      }
    }

    if (!managed) {
      console.log(`ERR: File '${filename}' does not exist`)
    }
  }

  function cleanDirectory () {
    if (pending === 0) {
      cleanEmptyFoldersRecursively(directory)
    } else {
      setTimeout(cleanDirectory, 500)
    }
  }

  setTimeout(cleanDirectory, 500)
}

/**
 * Creates `dirname` and any missing parent directory.
 *
 * @param {string} dirname
 */
export function mkdirRecurs (dirname) {
  try {
    fs.mkdirSync(dirname, { recursive: true })
  } catch (error) {
    console.error(`ERR: Cannot create directory ${dirname}`, error.message)
  }
}

/**
 * Removes a single file, reporting failures without throwing.
 *
 * @param {string} filename
 * @returns {boolean} Whether the file was removed.
 */
export function deleteFile (filename) {
  try {
    fs.unlinkSync(filename)
    console.log(`Removed file '${filename}'`)
    return true
  } catch (error) {
    console.error(`ERR: Cannot remove file ${filename}`, error.message)
    return false
  }
}

/**
 * Moves one file, falling back to a copy when source and destination sit on
 * different filesystems.
 *
 * @param {string} oldPath
 * @param {string} newPath
 * @param {(err?: Error) => void} callback
 */
export function moveFile (oldPath, newPath, callback) {
  const target = findNonExistingFilename(newPath)

  fs.rename(oldPath, target, (err) => {
    if (!err) {
      console.log(`Moved '${oldPath}' --> '${target}'`)
      callback()
      return
    }

    if (err.code !== 'EXDEV') {
      callback(err)
      return
    }

    // Source and destination are on different filesystems, so rename cannot
    // work: copy the content across, then drop the original.
    fs.copyFile(oldPath, target, (copyError) => {
      if (copyError) {
        callback(copyError)
        return
      }

      fs.unlink(oldPath, (unlinkError) => {
        if (!unlinkError) {
          console.log(`Moved (using copy) '${oldPath}' --> '${target}'`)
        }
        callback(unlinkError ?? undefined)
      })
    })
  })
}

/**
 * Returns `fullPath`, or the first `name-N.ext` variant in the same directory
 * that is still free, so that an existing file is never overwritten.
 *
 * @param {string} fullPath
 * @param {number} [limit] Safety bound on the number of attempts.
 * @returns {string}
 */
export function findNonExistingFilename (fullPath, limit = 100000) {
  if (!fs.existsSync(fullPath)) {
    return fullPath
  }

  const dirname = path.dirname(fullPath)
  const extname = path.extname(fullPath)
  const basename = path.basename(fullPath, extname)

  for (let count = 1; count <= limit; count++) {
    const candidate = path.join(dirname, `${basename}-${count}${extname}`)
    if (!fs.existsSync(candidate)) {
      return candidate
    }
  }

  throw new Error(`Cannot find a free file name for '${fullPath}' after ${limit} attempts`)
}

/**
 * Recursively removes the directories that are empty once the moves are done.
 *
 * The scanned root is kept: pruning it would delete the directory the user
 * pointed the command at.
 *
 * @param {string} folder
 * @param {{ removeRoot?: boolean }} [options]
 * @returns {boolean} Whether `folder` is now empty.
 */
export function cleanEmptyFoldersRecursively (folder, { removeRoot = false } = {}) {
  let entries
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true })
  } catch {
    return false
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      cleanEmptyFoldersRecursively(path.join(folder, entry.name), { removeRoot: true })
    }
  }

  const isEmpty = fs.readdirSync(folder).length === 0
  if (isEmpty && removeRoot) {
    try {
      fs.rmdirSync(folder)
      console.log(`Removed empty folder '${folder}'`)
    } catch (error) {
      console.error(`ERR: Cannot remove folder ${folder}`, error.message)
    }
  }

  return isEmpty
}
