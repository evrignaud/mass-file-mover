/**
 * Prefix used in a move list to mark an entry for deletion instead of a move.
 */
export const DELETE_MARKER = '[DEL]'

/**
 * The three listing layouts understood by the `list` command.
 *
 * - `files`     one path per line, no directory headers
 * - `flat-tree` a `directory/` header line followed by its bare file names
 * - `tree`      an indented tree, two spaces per nesting level
 */
export const LIST_TYPES = {
  files: 'files',
  flatTree: 'flat-tree',
  tree: 'tree'
}

/**
 * Whether applying a listing consumes the source tree or leaves it alone.
 */
export const TRANSFER_MODES = {
  move: 'move',
  copy: 'copy'
}

/**
 * What to do when a destination is already taken.
 *
 * - `rename`    give the incoming file a `name-1.ext` suffix (the default, and
 *               the only behaviour the first version had)
 * - `skip`      leave both the source and the destination untouched
 * - `overwrite` replace the file that is in the way
 * - `fail`      report the collision and end with a failure status
 */
export const CONFLICT_STRATEGIES = {
  rename: 'rename',
  skip: 'skip',
  overwrite: 'overwrite',
  fail: 'fail'
}

/**
 * Number of spaces that make up one indentation level in a `tree` listing.
 */
export const INDENT_WIDTH = 2
