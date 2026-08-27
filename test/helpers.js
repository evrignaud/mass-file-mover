import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * Creates an empty directory under the system temp folder.
 *
 * @param {string} [prefix]
 * @returns {Promise<string>} Absolute path.
 */
export async function makeTempDir (prefix = 'mfm-') {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix))
}

/**
 * Writes a set of files described by relative POSIX paths.
 *
 * @param {string} root
 * @param {Record<string, string>} files
 * @returns {Promise<string>} `root`, for chaining.
 */
export async function writeTree (root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, ...relative.split('/'))
    await fsp.mkdir(path.dirname(full), { recursive: true })
    await fsp.writeFile(full, content)
  }

  return root
}

/**
 * Creates a temp directory pre-filled with `files`.
 *
 * @param {Record<string, string>} [files]
 * @returns {Promise<string>} Absolute path of the root.
 */
export async function makeTempTree (files = {}) {
  return writeTree(await makeTempDir(), files)
}

/**
 * Reads back every file below `root` as `{ 'relative/posix/path': content }`,
 * so a whole tree can be asserted on in one comparison.
 *
 * @param {string} root
 * @returns {Promise<Record<string, string>>}
 */
export async function readTree (root) {
  const result = {}

  const walk = async (directory) => {
    let entries
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else {
        const relative = path.relative(root, full).split(path.sep).join('/')
        result[relative] = await fsp.readFile(full, 'utf8')
      }
    }
  }

  await walk(root)

  return result
}

/**
 * Lists the directories below `root`, as relative POSIX paths.
 *
 * @param {string} root
 * @returns {Promise<string[]>} Sorted.
 */
export async function readDirectories (root) {
  const result = []

  const walk = async (directory) => {
    const entries = await fsp.readdir(directory, { withFileTypes: true })
    for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
      const full = path.join(directory, entry.name)
      result.push(path.relative(root, full).split(path.sep).join('/'))
      await walk(full)
    }
  }

  await walk(root)

  return result.sort()
}

/**
 * Writes a listing file, joining the lines with the requested ending.
 *
 * @param {string} file
 * @param {string[]} lines
 * @param {{ eol?: string, bom?: boolean }} [options]
 * @returns {Promise<string>} `file`, for chaining.
 */
export async function writeListing (file, lines, { eol = '\n', bom = false } = {}) {
  const content = `${lines.join(eol)}${eol}`
  await fsp.writeFile(file, bom ? `\uFEFF${content}` : content)
  return file
}

/**
 * Removes a temp tree, ignoring anything already gone.
 *
 * @param {...string} roots
 * @returns {Promise<void>}
 */
export async function removeTree (...roots) {
  for (const root of roots) {
    await fsp.rm(root, { recursive: true, force: true })
  }
}
