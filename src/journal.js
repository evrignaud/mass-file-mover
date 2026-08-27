import fsp from 'node:fs/promises'
import path from 'node:path'

import { TRANSFER_MODES } from './constants.js'
import { silentLogger } from './logger.js'
import { cleanEmptyFoldersRecursively, ensureDirectory } from './move.js'

/**
 * Schema version of the journal file. Bumped if the shape ever changes, so an
 * old journal is rejected rather than misread.
 */
export const JOURNAL_VERSION = 1

/**
 * Records what a run actually did, so it can be walked back.
 *
 * @param {string} file Where to write the journal.
 * @param {object} entry
 * @param {string} entry.mode
 * @param {string} entry.directory
 * @param {string} entry.destination
 * @param {Array<object>} entry.operations
 * @param {string} [entry.toolVersion]
 * @returns {Promise<void>}
 */
export async function writeJournal (file, { mode, directory, destination, operations, toolVersion }) {
  const journal = {
    version: JOURNAL_VERSION,
    tool: 'mass-file-mover',
    toolVersion,
    createdAt: new Date().toISOString(),
    mode,
    directory,
    destination,
    operations
  }

  await ensureDirectory(path.dirname(path.resolve(file)))
  await fsp.writeFile(file, `${JSON.stringify(journal, null, 2)}\n`)
}

/**
 * Loads a journal, rejecting anything this version cannot interpret.
 *
 * @param {string} file
 * @returns {Promise<object>}
 */
export async function readJournal (file) {
  let journal
  try {
    journal = JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot read journal '${file}': ${error.message}`, { cause: error })
  }

  if (journal?.tool !== 'mass-file-mover') {
    throw new Error(`'${file}' is not a mass-file-mover journal`)
  }

  if (journal.version !== JOURNAL_VERSION) {
    throw new Error(`Journal '${file}' has version ${journal.version}, expected ${JOURNAL_VERSION}`)
  }

  if (!Array.isArray(journal.operations)) {
    throw new Error(`Journal '${file}' has no operations`)
  }

  return journal
}

/**
 * Walks a journal back: moved files return to where they came from and copies
 * are removed.
 *
 * Deletions cannot be undone, the content is gone. They are reported so the
 * outcome is never silently partial.
 *
 * @param {object} journal
 * @param {object} [options]
 * @param {boolean} [options.dryRun]
 * @param {boolean} [options.prune] Remove destination directories left empty.
 * @param {object} [options.logger]
 * @returns {Promise<{ restored: number, removed: number, irreversible: number, failed: number, dryRun: boolean }>}
 */
export async function undoJournal (journal, { dryRun = false, prune = true, logger = silentLogger } = {}) {
  const summary = { restored: 0, removed: 0, irreversible: 0, failed: 0, dryRun }

  // Reverse order, so a file moved twice lands back at its first location.
  for (const operation of [...journal.operations].reverse()) {
    if (operation.type === 'delete') {
      summary.irreversible++
      logger.warn(`Cannot restore deleted file '${operation.path}'`)
      continue
    }

    if (operation.type === 'copy') {
      if (dryRun) {
        summary.removed++
        logger.info(`Would remove copy '${operation.to}'`)
        continue
      }

      try {
        await fsp.unlink(operation.to)
        summary.removed++
        logger.info(`Removed copy '${operation.to}'`)
      } catch (error) {
        summary.failed++
        logger.error(`Cannot remove copy '${operation.to}': ${error.message}`)
      }
      continue
    }

    if (operation.type !== 'move') {
      summary.failed++
      logger.error(`Unknown journal operation '${operation.type}'`)
      continue
    }

    if (operation.overwritten) {
      logger.warn(`'${operation.to}' replaced a file whose content cannot be brought back`)
    }

    if (dryRun) {
      summary.restored++
      logger.info(`Would move '${operation.to}' --> '${operation.from}'`)
      continue
    }

    try {
      await ensureDirectory(path.dirname(operation.from), logger)
      await fsp.rename(operation.to, operation.from)
      summary.restored++
      logger.info(`Moved back '${operation.to}' --> '${operation.from}'`)
    } catch (error) {
      summary.failed++
      logger.error(`Cannot move '${operation.to}' back to '${operation.from}': ${error.message}`)
    }
  }

  if (prune && !dryRun && journal.destination && journal.mode === TRANSFER_MODES.move) {
    await cleanEmptyFoldersRecursively(journal.destination, { logger })
  }

  return summary
}
