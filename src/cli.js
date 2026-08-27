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
  process.exit(-1)
}

/**
 * Parses `argv` and runs the matching command.
 *
 * @param {string[]} [argv] Full argv, including the node and script entries.
 */
export function run (argv = process.argv) {
  if (argv.length < 3) {
    badUsage()
    return
  }

  switch (argv[2]) {
    case 'list-files':
      listDirectory(LIST_TYPES.files, argv[3], argv[4])
      break
    case 'list-flat-tree':
      listDirectory(LIST_TYPES.flatTree, argv[3], argv[4])
      break
    case 'list-tree':
      listDirectory(LIST_TYPES.tree, argv[3], argv[4])
      break
    case 'move':
      moveFiles(argv[3], argv[4], argv[5])
      break
    default:
      badUsage()
  }
}
