/**
 * Removes the UTF-8 byte order mark that Windows editors such as Notepad add
 * when saving a listing.
 *
 * @param {string} content
 * @returns {string}
 */
export function stripBom (content) {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
}

/**
 * Splits text into lines, accepting LF, CRLF and CR endings.
 *
 * Splitting on `\n` alone leaves a trailing carriage return on every line of a
 * CRLF file, which turns each entry into a file name that cannot be found.
 *
 * @param {string} content
 * @returns {string[]}
 */
export function splitLines (content) {
  return stripBom(content).split(/\r\n|\r|\n/)
}
