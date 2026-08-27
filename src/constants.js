/**
 * Prefix used in a move list to mark an entry for deletion instead of a move.
 */
export const DELETE_MARKER = '[DEL]'

/**
 * The three listing layouts understood by the `list-*` commands.
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
 * Number of spaces that make up one indentation level in a `tree` listing.
 */
export const INDENT_WIDTH = 2
