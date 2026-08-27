import process from 'node:process'

import { LIST_TYPES } from './constants.js'
import { listDirectory } from './list.js'
import { moveFiles } from './move.js'

const USAGE = `Invalid usage.
  mass-file-mover list-files <directory|.> <fileList filename|fileList>
  mass-file-mover list-flat-tree <directory|.> <fileList filename|fileList>
  mass-file-mover list-tree <directory|.> <fileList filename|fileList>
  mass-file-mover move <moveList> <directory|.> <base destination dir>`

/**
 * Prints the usage banner and terminates with a failure status.
 */
export function badUsage () {
  console.error(USAGE)
  process.exit(1)
}

/**
 * Parses `argv` and runs the matching command.
 *
 * @param {string[]} [argv] Full argv, including the node and script entries.
 * @returns {Promise<number>} Process exit code.
 */
export async function run (argv = process.argv) {
  if (argv.length < 3) {
    badUsage()
    return 1
  }

  switch (argv[2]) {
    case 'list-files':
      listDirectory(LIST_TYPES.files, argv[3], argv[4])
      return 0
    case 'list-flat-tree':
      listDirectory(LIST_TYPES.flatTree, argv[3], argv[4])
      return 0
    case 'list-tree':
      listDirectory(LIST_TYPES.tree, argv[3], argv[4])
      return 0
    case 'move': {
      const summary = await moveFiles(argv[3], argv[4], argv[5])
      reportSummary(summary)
      // A run that could not carry out everything it was asked to must not
      // look like a success to the calling shell.
      return summary.failed + summary.missing > 0 ? 1 : 0
    }
    default:
      badUsage()
      return 1
  }
}

/**
 * Prints the one-line outcome of a move run.
 *
 * @param {{ moved: number, copied: number, deleted: number, failed: number, missing: number }} summary
 */
export function reportSummary (summary) {
  const parts = [`${summary.moved} moved`]
  if (summary.copied) parts.push(`${summary.copied} across filesystems`)
  if (summary.deleted) parts.push(`${summary.deleted} deleted`)
  if (summary.missing) parts.push(`${summary.missing} not found`)
  if (summary.failed) parts.push(`${summary.failed} failed`)

  console.log(parts.join(', '))
}
