import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { DEFAULT_CONCURRENCY, mapWithConcurrency } from './concurrency.js'
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
 * Resolves a move list into the concrete source/target pairs it describes,
 * without touching the filesystem beyond the collision checks.
 *
 * Planning every target up front, before a single file is renamed, is what
 * lets collisions be resolved deterministically: each chosen name is reserved,
 * so two entries landing on the same destination cannot pick it twice.
 *
 * @param {object} params
 * @param {Array<{ type: string, relative?: string, target?: string }>} params.operations
 * @param {Map<string, string[]>} params.fileList
 * @param {Map<string, string[]>} params.withoutExtList
 * @param {string} params.directory
 * @param {string} params.baseDestinationDir
 * @returns {{
 *   moves: Array<{ oldPath: string, target: string }>,
 *   deletes: string[],
 *   directories: string[],
 *   missing: string[]
 * }}
 */
export function planOperations ({
  operations,
  fileList,
  withoutExtList,
  directory,
  baseDestinationDir
}) {
  const moves = []
  const deletes = []
  const directories = []
  const missing = []

  const claimedSources = new Set()
  const reservedTargets = new Set()

  const planMove = (filename, desiredTarget) => {
    for (const sourceDir of fileList.get(filename)) {
      const oldPath = path.join(sourceDir, filename)
      if (claimedSources.has(oldPath)) {
        continue
      }

      const target = findNonExistingFilename(desiredTarget, { reserved: reservedTargets })
      if (path.resolve(oldPath) === path.resolve(target)) {
        // Already where the list wants it.
        claimedSources.add(oldPath)
        continue
      }

      claimedSources.add(oldPath)
      reservedTargets.add(path.resolve(target))
      moves.push({ oldPath, target })
    }
  }

  for (const operation of operations) {
    if (operation.type === 'delete') {
      const { target } = operation

      if (target.includes('/') || target.includes(path.sep)) {
        deletes.push(path.join(directory, ...target.split(/[/\\]/)))
        continue
      }

      const sourceDirs = fileList.get(target)
      if (!sourceDirs) {
        missing.push(target)
        console.error(`ERR: Cannot remove '${target}': no such file under '${directory}'`)
        continue
      }

      for (const sourceDir of sourceDirs) {
        deletes.push(path.join(sourceDir, target))
      }
      continue
    }

    const destination = resolveDestination(baseDestinationDir, operation.relative)
    directories.push(path.dirname(destination))

    let managed = false

    const filename = path.basename(destination)
    if (fileList.has(filename)) {
      planMove(filename, destination)
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
          planMove(withExtension, destination + path.extname(withExtension))
          managed = true
        }
      }
    }

    if (!managed) {
      missing.push(filename)
      console.error(`ERR: File '${filename}' does not exist`)
    }
  }

  return { moves, deletes, directories, missing }
}

/**
 * Applies a move list: every entry is moved to its new location, entries
 * flagged with the delete marker are removed, and source directories left
 * empty afterwards are pruned.
 *
 * @param {string} [moveList]
 * @param {string} [directory]
 * @param {string} [baseDestinationDir]
 * @param {{ concurrency?: number }} [options]
 * @returns {Promise<{ moved: number, copied: number, deleted: number, failed: number, missing: number }>}
 */
export async function moveFiles (
  moveList = 'fileList',
  directory = '.',
  baseDestinationDir = '.',
  { concurrency = DEFAULT_CONCURRENCY } = {}
) {
  const { fileList, withoutExtList } = makeFileList(directory, moveList)
  const operations = parseMoveList(await fsp.readFile(moveList, 'utf8'))

  const plan = planOperations({
    operations,
    fileList,
    withoutExtList,
    directory,
    baseDestinationDir
  })

  const summary = {
    moved: 0,
    copied: 0,
    deleted: 0,
    failed: 0,
    missing: plan.missing.length
  }

  for (const dirname of new Set(plan.directories)) {
    if (!await ensureDirectory(dirname)) {
      summary.failed++
    }
  }

  for (const filename of plan.deletes) {
    if (await deleteFile(filename)) {
      summary.deleted++
    } else {
      summary.failed++
    }
  }

  await mapWithConcurrency(plan.moves, concurrency, async ({ oldPath, target }) => {
    try {
      const { copied } = await moveFile(oldPath, target)
      summary.moved++
      if (copied) {
        summary.copied++
      }
      console.log(`Moved${copied ? ' (using copy)' : ''} '${oldPath}' --> '${target}'`)
    } catch (error) {
      summary.failed++
      console.error(`ERR: Error moving '${oldPath}' to '${target}'`, error.message)
    }
  })

  await cleanEmptyFoldersRecursively(directory)

  return summary
}

/**
 * Creates `dirname` and any missing parent directory.
 *
 * @param {string} dirname
 * @returns {Promise<boolean>} Whether the directory exists afterwards.
 */
export async function ensureDirectory (dirname) {
  try {
    await fsp.mkdir(dirname, { recursive: true })
    return true
  } catch (error) {
    console.error(`ERR: Cannot create directory ${dirname}`, error.message)
    return false
  }
}

/**
 * Removes a single file, reporting failures without throwing.
 *
 * @param {string} filename
 * @returns {Promise<boolean>} Whether the file was removed.
 */
export async function deleteFile (filename) {
  try {
    await fsp.unlink(filename)
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
 * @returns {Promise<{ path: string, copied: boolean }>}
 */
export async function moveFile (oldPath, newPath) {
  try {
    await fsp.rename(oldPath, newPath)
    return { path: newPath, copied: false }
  } catch (error) {
    if (error.code !== 'EXDEV') {
      throw error
    }
  }

  // Source and destination are on different filesystems, so rename cannot
  // work: copy the content across, then drop the original. The copy is
  // exclusive so a file that appeared in the meantime is never clobbered.
  await fsp.copyFile(oldPath, newPath, fs.constants.COPYFILE_EXCL)
  await fsp.unlink(oldPath)

  return { path: newPath, copied: true }
}

/**
 * Returns `fullPath`, or the first `name-N.ext` variant in the same directory
 * that is neither on disk nor already reserved, so that an existing file is
 * never overwritten.
 *
 * @param {string} fullPath
 * @param {{ reserved?: Set<string>, limit?: number }} [options]
 * @returns {string}
 */
export function findNonExistingFilename (fullPath, { reserved, limit = 100000 } = {}) {
  const isFree = (candidate) =>
    !fs.existsSync(candidate) && !reserved?.has(path.resolve(candidate))

  if (isFree(fullPath)) {
    return fullPath
  }

  const dirname = path.dirname(fullPath)
  const extname = path.extname(fullPath)
  const basename = path.basename(fullPath, extname)

  for (let count = 1; count <= limit; count++) {
    const candidate = path.join(dirname, `${basename}-${count}${extname}`)
    if (isFree(candidate)) {
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
 * @returns {Promise<boolean>} Whether `folder` is now empty.
 */
export async function cleanEmptyFoldersRecursively (folder, { removeRoot = false } = {}) {
  let entries
  try {
    entries = await fsp.readdir(folder, { withFileTypes: true })
  } catch {
    return false
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      await cleanEmptyFoldersRecursively(path.join(folder, entry.name), { removeRoot: true })
    }
  }

  const remaining = await fsp.readdir(folder)
  if (remaining.length === 0 && removeRoot) {
    try {
      await fsp.rmdir(folder)
      console.log(`Removed empty folder '${folder}'`)
    } catch (error) {
      console.error(`ERR: Cannot remove folder ${folder}`, error.message)
    }
  }

  return remaining.length === 0
}
