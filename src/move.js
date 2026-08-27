import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { DEFAULT_CONCURRENCY, mapWithConcurrency } from './concurrency.js'
import { CONFLICT_STRATEGIES, DELETE_MARKER, TRANSFER_MODES } from './constants.js'
import { createIgnoreMatcher } from './ignore.js'
import { silentLogger } from './logger.js'
import {
  normalizeDirectory,
  readLevel,
  resolveDestination,
  splitDirectory
} from './paths.js'
import { splitLines } from './text.js'
import { walkSync } from './walk.js'

/**
 * Indexes every file below `directory` by name and by name-without-extension
 * so a move list entry can be resolved wherever the file happens to live.
 *
 * @param {string} directory
 * @param {object} [options]
 * @param {string} [options.exclude] Path of the move list, left out of the index.
 * @param {(relativePath: string) => boolean} [options.isIgnored]
 * @param {object} [options.logger]
 * @returns {{ fileList: Map<string, string[]>, withoutExtList: Map<string, string[]> }}
 */
export function makeFileList (directory, { exclude, isIgnored, logger = silentLogger } = {}) {
  const fileList = new Map()
  const withoutExtList = new Map()
  const excluded = exclude ? path.resolve(exclude) : null

  walkSync(directory, ({ basedir, filename, fullPath }) => {
    if (excluded && path.resolve(fullPath) === excluded) {
      return
    }

    const dirs = fileList.get(filename)
    if (dirs) {
      logger.warn(`File '${filename}' found several times`)
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
  }, { isIgnored, logger })

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
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) {
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
 * without changing anything on disk.
 *
 * Planning every target up front, before a single file is renamed, is what
 * lets collisions be resolved deterministically: each chosen name is reserved,
 * so two entries landing on the same destination cannot pick it twice. It is
 * also what makes `--dry-run` an honest preview rather than a second code path.
 *
 * @param {object} params
 * @param {Array<{ type: string, relative?: string, target?: string }>} params.operations
 * @param {Map<string, string[]>} params.fileList
 * @param {Map<string, string[]>} params.withoutExtList
 * @param {string} params.directory
 * @param {string} params.baseDestinationDir
 * @param {string} [params.mode] One of {@link TRANSFER_MODES}.
 * @param {string} [params.onConflict] One of {@link CONFLICT_STRATEGIES}.
 * @param {object} [params.logger]
 * @returns {{
 *   moves: Array<{ oldPath: string, target: string, overwrite: boolean }>,
 *   deletes: string[],
 *   directories: string[],
 *   unchanged: string[],
 *   skipped: string[],
 *   conflicts: string[],
 *   missing: string[]
 * }}
 */
export function planOperations ({
  operations,
  fileList,
  withoutExtList,
  directory,
  baseDestinationDir,
  mode = TRANSFER_MODES.move,
  onConflict = CONFLICT_STRATEGIES.rename,
  logger = silentLogger
}) {
  const moves = []
  const deletes = []
  const directories = []
  const unchanged = []
  const skipped = []
  const conflicts = []
  const missing = []

  const claimedSources = new Set()
  const reservedTargets = new Set()

  const planMove = (filename, desiredTarget) => {
    for (const sourceDir of fileList.get(filename)) {
      const oldPath = path.join(sourceDir, filename)
      if (claimedSources.has(oldPath)) {
        continue
      }
      claimedSources.add(oldPath)

      if (path.resolve(oldPath) === path.resolve(desiredTarget)) {
        // Already where the list wants it.
        unchanged.push(oldPath)
        logger.debug(`Unchanged '${oldPath}'`)
        continue
      }

      const resolution = resolveTarget(desiredTarget, {
        reserved: reservedTargets,
        onConflict
      })

      if (resolution.conflict) {
        conflicts.push(desiredTarget)
      }

      if (resolution.action === 'skip') {
        skipped.push(oldPath)
        logger.warn(`Skipped '${oldPath}': '${desiredTarget}' already exists`)
        continue
      }

      if (resolution.action === 'fail') {
        missing.push(oldPath)
        logger.error(`Cannot place '${oldPath}': '${desiredTarget}' already exists`)
        continue
      }

      reservedTargets.add(path.resolve(resolution.target))
      moves.push({
        oldPath,
        target: resolution.target,
        overwrite: resolution.action === 'overwrite'
      })
    }
  }

  for (const operation of operations) {
    if (operation.type === 'delete') {
      const { target } = operation

      // Copying is meant to leave the source tree alone, so a delete marker
      // just means "leave this one out" rather than "remove it".
      if (mode === TRANSFER_MODES.copy) {
        logger.debug(`Not copying '${target}' (marked ${DELETE_MARKER})`)
        continue
      }

      if (target.includes('/') || target.includes(path.sep)) {
        deletes.push(path.join(directory, ...target.split(/[/\\]/)))
        continue
      }

      const sourceDirs = fileList.get(target)
      if (!sourceDirs) {
        missing.push(target)
        logger.error(`Cannot remove '${target}': no such file under '${directory}'`)
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
      logger.error(`File '${filename}' does not exist`)
    }
  }

  return { moves, deletes, directories, unchanged, skipped, conflicts, missing }
}

/**
 * Decides where a file goes when something already occupies its destination.
 *
 * @param {string} desiredTarget
 * @param {object} options
 * @param {Set<string>} [options.reserved] Targets already claimed by this plan.
 * @param {string} [options.onConflict] One of {@link CONFLICT_STRATEGIES}.
 * @returns {{ target: string, conflict: boolean, action: 'create'|'rename'|'overwrite'|'skip'|'fail' }}
 */
export function resolveTarget (desiredTarget, { reserved, onConflict = CONFLICT_STRATEGIES.rename } = {}) {
  const taken = fs.existsSync(desiredTarget) || Boolean(reserved?.has(path.resolve(desiredTarget)))

  if (!taken) {
    return { target: desiredTarget, conflict: false, action: 'create' }
  }

  switch (onConflict) {
    case CONFLICT_STRATEGIES.skip:
      return { target: desiredTarget, conflict: true, action: 'skip' }
    case CONFLICT_STRATEGIES.overwrite:
      return { target: desiredTarget, conflict: true, action: 'overwrite' }
    case CONFLICT_STRATEGIES.fail:
      return { target: desiredTarget, conflict: true, action: 'fail' }
    case CONFLICT_STRATEGIES.rename:
      return {
        target: findNonExistingFilename(desiredTarget, { reserved }),
        conflict: true,
        action: 'rename'
      }
    default:
      throw new Error(`Unknown conflict strategy '${onConflict}'`)
  }
}

/**
 * Applies a listing: every entry is moved, or copied, to its new location,
 * entries flagged with the delete marker are removed, and source directories
 * left empty afterwards are pruned.
 *
 * @param {string} [moveList]
 * @param {string} [directory]
 * @param {string} [baseDestinationDir]
 * @param {object} [options]
 * @param {boolean} [options.dryRun] Report the plan without applying it.
 * @param {string} [options.mode] One of {@link TRANSFER_MODES}.
 * @param {string} [options.onConflict] One of {@link CONFLICT_STRATEGIES}.
 * @param {boolean} [options.prune] Remove source directories left empty.
 * @param {number} [options.concurrency]
 * @param {string[]} [options.ignore]
 * @param {boolean} [options.defaultIgnores]
 * @param {object} [options.logger]
 * @returns {Promise<object>} Summary of the run, including the journal entries
 *   describing what was actually carried out.
 */
export async function moveFiles (
  moveList = 'fileList',
  directory = '.',
  baseDestinationDir = '.',
  options = {}
) {
  const {
    dryRun = false,
    mode = TRANSFER_MODES.move,
    onConflict = CONFLICT_STRATEGIES.rename,
    concurrency = DEFAULT_CONCURRENCY,
    ignore = [],
    defaultIgnores = true,
    logger = silentLogger
  } = options

  // Copying is non-destructive by definition, so it never prunes the tree it
  // read from.
  const prune = mode === TRANSFER_MODES.copy ? false : options.prune !== false

  if (!Object.values(TRANSFER_MODES).includes(mode)) {
    throw new Error(`Unknown transfer mode '${mode}'`)
  }

  if (!Object.values(CONFLICT_STRATEGIES).includes(onConflict)) {
    throw new Error(`Unknown conflict strategy '${onConflict}'. Expected one of ${Object.values(CONFLICT_STRATEGIES).join(', ')}`)
  }

  if (!fs.existsSync(moveList)) {
    throw new Error(`Move list '${moveList}' does not exist`)
  }

  if (!fs.existsSync(directory)) {
    throw new Error(`Directory '${directory}' does not exist`)
  }

  const isIgnored = createIgnoreMatcher(ignore, { useDefaults: defaultIgnores })
  logger.debug(`Ignoring: ${isIgnored.patterns.join(', ') || '(nothing)'}`)

  const { fileList, withoutExtList } = makeFileList(directory, {
    exclude: moveList,
    isIgnored,
    logger
  })

  const operations = parseMoveList(await fsp.readFile(moveList, 'utf8'))

  const plan = planOperations({
    operations,
    fileList,
    withoutExtList,
    directory,
    baseDestinationDir,
    mode,
    onConflict,
    logger
  })

  const verb = mode === TRANSFER_MODES.copy ? 'Copied' : 'Moved'
  const journalEntries = []

  const summary = {
    mode,
    dryRun,
    moved: 0,
    copied: 0,
    crossDevice: 0,
    deleted: 0,
    unchanged: plan.unchanged.length,
    skipped: plan.skipped.length,
    conflicts: plan.conflicts.length,
    failed: 0,
    missing: plan.missing.length,
    operations: journalEntries
  }

  const counter = mode === TRANSFER_MODES.copy ? 'copied' : 'moved'

  if (dryRun) {
    for (const filename of plan.deletes) {
      logger.info(`Would remove '${filename}'`)
      summary.deleted++
    }
    for (const { oldPath, target, overwrite } of plan.moves) {
      logger.info(`Would ${mode} '${oldPath}' --> '${target}'${overwrite ? ' (overwriting)' : ''}`)
      summary[counter]++
    }
    return summary
  }

  for (const dirname of new Set(plan.directories)) {
    if (!await ensureDirectory(dirname, logger)) {
      summary.failed++
    }
  }

  for (const filename of plan.deletes) {
    if (await deleteFile(filename, logger)) {
      summary.deleted++
      journalEntries.push({ type: 'delete', path: filename })
    } else {
      summary.failed++
    }
  }

  await mapWithConcurrency(plan.moves, concurrency, async ({ oldPath, target, overwrite }) => {
    try {
      const { crossDevice } = await transferFile(oldPath, target, { mode, overwrite })

      summary[counter]++
      if (crossDevice) {
        summary.crossDevice++
      }

      journalEntries.push({
        type: mode,
        from: oldPath,
        to: target,
        ...(overwrite ? { overwritten: true } : {})
      })

      logger.info(`${verb}${crossDevice ? ' (across filesystems)' : ''} '${oldPath}' --> '${target}'`)
    } catch (error) {
      summary.failed++
      logger.error(`Cannot ${mode} '${oldPath}' to '${target}': ${error.message}`)
    }
  })

  if (prune) {
    await cleanEmptyFoldersRecursively(directory, { logger })
  }

  return summary
}

/**
 * Creates `dirname` and any missing parent directory.
 *
 * @param {string} dirname
 * @param {object} [logger]
 * @returns {Promise<boolean>} Whether the directory exists afterwards.
 */
export async function ensureDirectory (dirname, logger = silentLogger) {
  try {
    await fsp.mkdir(dirname, { recursive: true })
    return true
  } catch (error) {
    logger.error(`Cannot create directory ${dirname}: ${error.message}`)
    return false
  }
}

/**
 * Removes a single file, reporting failures without throwing.
 *
 * @param {string} filename
 * @param {object} [logger]
 * @returns {Promise<boolean>} Whether the file was removed.
 */
export async function deleteFile (filename, logger = silentLogger) {
  try {
    await fsp.unlink(filename)
    logger.info(`Removed file '${filename}'`)
    return true
  } catch (error) {
    logger.error(`Cannot remove file ${filename}: ${error.message}`)
    return false
  }
}

/**
 * Puts one file at its new location, either moving or copying it.
 *
 * A move is a rename, which falls back to copy-then-delete when source and
 * destination sit on different filesystems.
 *
 * @param {string} oldPath
 * @param {string} newPath
 * @param {object} [options]
 * @param {string} [options.mode] One of {@link TRANSFER_MODES}.
 * @param {boolean} [options.overwrite] Allow replacing an existing file.
 * @returns {Promise<{ path: string, crossDevice: boolean }>}
 */
export async function transferFile (
  oldPath,
  newPath,
  { mode = TRANSFER_MODES.move, overwrite = false } = {}
) {
  // Without an explicit overwrite the copy is exclusive, so a file that
  // appeared since the plan was built is never clobbered.
  const copyFlags = overwrite ? 0 : fs.constants.COPYFILE_EXCL

  if (mode === TRANSFER_MODES.copy) {
    await fsp.copyFile(oldPath, newPath, copyFlags)
    return { path: newPath, crossDevice: false }
  }

  try {
    await fsp.rename(oldPath, newPath)
    return { path: newPath, crossDevice: false }
  } catch (error) {
    if (error.code !== 'EXDEV') {
      throw error
    }
  }

  // Source and destination are on different filesystems, so rename cannot
  // work: copy the content across, then drop the original.
  await fsp.copyFile(oldPath, newPath, copyFlags)
  await fsp.unlink(oldPath)

  return { path: newPath, crossDevice: true }
}

/**
 * Moves one file. A thin wrapper over {@link transferFile}.
 *
 * @param {string} oldPath
 * @param {string} newPath
 * @param {{ overwrite?: boolean }} [options]
 * @returns {Promise<{ path: string, crossDevice: boolean }>}
 */
export async function moveFile (oldPath, newPath, options = {}) {
  return transferFile(oldPath, newPath, { ...options, mode: TRANSFER_MODES.move })
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
 * @param {{ removeRoot?: boolean, logger?: object }} [options]
 * @returns {Promise<boolean>} Whether `folder` is now empty.
 */
export async function cleanEmptyFoldersRecursively (
  folder,
  { removeRoot = false, logger = silentLogger } = {}
) {
  let entries
  try {
    entries = await fsp.readdir(folder, { withFileTypes: true })
  } catch {
    return false
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      await cleanEmptyFoldersRecursively(path.join(folder, entry.name), {
        removeRoot: true,
        logger
      })
    }
  }

  const remaining = await fsp.readdir(folder)
  if (remaining.length === 0 && removeRoot) {
    try {
      await fsp.rmdir(folder)
      logger.info(`Removed empty folder '${folder}'`)
    } catch (error) {
      logger.error(`Cannot remove folder ${folder}: ${error.message}`)
    }
  }

  return remaining.length === 0
}
