import fs from 'node:fs'
import process from 'node:process'

import { Command, Option } from 'commander'

import { DEFAULT_CONCURRENCY } from './concurrency.js'
import { DELETE_MARKER, LIST_TYPES } from './constants.js'
import { DEFAULT_IGNORES } from './ignore.js'
import { listDirectory } from './list.js'
import { createLogger } from './logger.js'
import { moveFiles } from './move.js'

const { version } = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')
)

const LIST_FORMATS = Object.values(LIST_TYPES)

const EXAMPLES = `
Examples:
  Write the tree of ./photos to a file, edit it, then apply it:

    $ mass-file-mover list photos -o plan.txt
    $ $EDITOR plan.txt
    $ mass-file-mover move plan.txt photos sorted --dry-run
    $ mass-file-mover move plan.txt photos sorted

  In a listing, a line ending with '/' opens a directory and the indented
  lines below it are its contents. Rename a line to rename the file, move it
  under another directory to move the file, and prefix it with '${DELETE_MARKER}' to
  delete it instead. A name written without an extension moves every file
  sharing that stem, so 'IMG_0042' carries both the .jpg and the .raw.
`

/**
 * Collects a repeatable option into an array.
 *
 * @param {string} value
 * @param {string[]} previous
 * @returns {string[]}
 */
function collect (value, previous) {
  return [...previous, value]
}

/**
 * Parses and validates a positive integer option.
 *
 * @param {string} value
 * @returns {number}
 */
function parsePositiveInteger (value) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, got '${value}'`)
  }
  return parsed
}

/**
 * Adds the options every command shares.
 *
 * @param {Command} command
 * @returns {Command}
 */
function withCommonOptions (command) {
  return command
    .option('-i, --ignore <pattern>', 'skip paths matching a glob, repeatable', collect, [])
    .option('--no-default-ignores', `keep ${DEFAULT_IGNORES.join(', ')} in the listing`)
    .option('-v, --verbose', 'also report what was skipped')
    .option('-q, --quiet', 'report only errors and the summary')
    .option('--no-color', 'disable coloured output')
}

/**
 * Turns parsed options into the shape the library functions expect.
 *
 * @param {object} options
 * @returns {object}
 */
function toRunOptions (options) {
  const level = options.quiet ? 'quiet' : (options.verbose ? 'verbose' : 'normal')

  return {
    ignore: options.ignore ?? [],
    defaultIgnores: options.defaultIgnores !== false,
    logger: createLogger({
      level,
      // Commander defaults --no-color to true, which would force colours on
      // even into a pipe. Only an explicit --no-color turns them off.
      color: options.color === false ? false : undefined
    })
  }
}

/**
 * Prints the one-line outcome of a move run.
 *
 * @param {object} summary
 * @param {object} logger
 */
export function reportSummary (summary, logger) {
  const parts = [`${summary.moved} ${summary.dryRun ? 'to move' : 'moved'}`]
  if (summary.copied) parts.push(`${summary.copied} across filesystems`)
  if (summary.deleted) parts.push(`${summary.deleted} ${summary.dryRun ? 'to delete' : 'deleted'}`)
  if (summary.unchanged) parts.push(`${summary.unchanged} already in place`)
  if (summary.missing) parts.push(`${summary.missing} not found`)
  if (summary.failed) parts.push(`${summary.failed} failed`)

  const line = parts.join(', ')
  logger.out(summary.dryRun ? `${line} (dry run, nothing changed)` : line)
}

/**
 * Builds the command tree.
 *
 * @param {(code: number) => void} setExitCode
 * @returns {Command}
 */
export function buildProgram (setExitCode = () => {}) {
  const program = new Command()

  program
    .name('mass-file-mover')
    .description('Reorganise a whole tree of files through an editable plain-text listing.')
    .version(version, '-V, --version')
    .addHelpText('after', EXAMPLES)
    .showHelpAfterError('(run with --help for usage)')
    .showSuggestionAfterError()

  const runList = (format, directory, output, options) => {
    const runOptions = toRunOptions(options)
    const count = listDirectory(format, directory, output, runOptions)
    runOptions.logger.out(`${count} file${count === 1 ? '' : 's'} listed in '${output}'`)
  }

  withCommonOptions(
    program
      .command('list')
      .description('write the files of a directory to an editable listing')
      .argument('[directory]', 'directory to scan', '.')
      .addOption(
        new Option('-f, --format <format>', 'listing layout')
          .choices(LIST_FORMATS)
          .default(LIST_TYPES.tree)
      )
      .option('-o, --output <file>', 'file to write the listing to', 'fileList')
  ).action((directory, options) => {
    runList(options.format, directory, options.output, options)
  })

  // The original command names, kept so existing scripts keep working.
  for (const format of LIST_FORMATS) {
    withCommonOptions(
      program
        .command(`list-${format}`)
        .description(`alias for: list --format ${format}`)
        .argument('[directory]', 'directory to scan', '.')
        .argument('[output]', 'file to write the listing to', 'fileList')
    ).action((directory, output, options) => {
      runList(format, directory, output, options)
    })
  }

  withCommonOptions(
    program
      .command('move')
      .description('apply an edited listing, moving and deleting files')
      .argument('[moveList]', 'the edited listing to apply', 'fileList')
      .argument('[directory]', 'directory the files come from', '.')
      .argument('[destination]', 'directory the tree is rebuilt under', '.')
      .option('-n, --dry-run', 'report what would happen, change nothing')
      .option('--no-prune', 'keep source directories that end up empty')
      .option(
        '-j, --concurrency <count>',
        'file operations in flight at once',
        parsePositiveInteger,
        DEFAULT_CONCURRENCY
      )
  ).action(async (moveList, directory, destination, options) => {
    const runOptions = toRunOptions(options)
    const summary = await moveFiles(moveList, directory, destination, {
      ...runOptions,
      dryRun: Boolean(options.dryRun),
      prune: options.prune !== false,
      concurrency: options.concurrency
    })

    reportSummary(summary, runOptions.logger)

    // A run that could not carry out everything it was asked to must not look
    // like a success to the calling shell.
    if (summary.failed + summary.missing > 0) {
      setExitCode(1)
    }
  })

  return program
}

/**
 * Parses `argv` and runs the matching command.
 *
 * @param {string[]} [argv] Full argv, including the node and script entries.
 * @returns {Promise<number>} Process exit code.
 */
export async function run (argv = process.argv) {
  let exitCode = 0
  const program = buildProgram((code) => {
    exitCode = code
  })

  if (argv.length < 3) {
    program.outputHelp()
    return 1
  }

  await program.parseAsync(argv)

  return exitCode
}
