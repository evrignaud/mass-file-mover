import fs from 'node:fs'
import path from 'node:path'

import { DELETE_MARKER, LIST_TYPES } from './constants.js'
import { buildLevel, findNewParts, sortPaths } from './paths.js'
import { isDotFimDir, walkSync } from './walk.js'

/**
 * Walks `directory` and writes the discovered files to `fileList` using the
 * layout selected by `listType`.
 *
 * @param {string} listType One of {@link LIST_TYPES}.
 * @param {string} [directory]
 * @param {string} [fileList]
 */
export function listDirectory (listType, directory = '.', fileList = 'fileList') {
  const filenames = []
  const fileListFilename = path.basename(fileList)

  walkSync(directory, (basedir, filename, stat) => {
    if (stat.isDirectory() || isDotFimDir(basedir)) {
      return
    }

    // Never list the output file itself.
    if (fileListFilename === filename && path.join(basedir, filename) === fileList) {
      return
    }

    if (filename.startsWith(DELETE_MARKER)) {
      console.log(`WARN: File '${filename}' has a name starting with the delete marker. This file will be deleted by the move command`)
    }

    if (listType) {
      filenames.push(path.join(basedir, filename))
    } else {
      if (filenames.includes(filename)) {
        console.log(`WARN: File '${filename}' found several times`)
      } else {
        filenames.push(filename)
      }
    }
  })

  const sortedFilenames = sortPaths(filenames)

  if (listType === LIST_TYPES.files) {
    writeFileList(fileList, sortedFilenames)
  } else {
    writeFullTree(listType, fileList, sortedFilenames)
  }
}

/**
 * Writes one path per line.
 *
 * @param {string} fileList
 * @param {string[]} filenames
 */
export function writeFileList (fileList, filenames) {
  const writeStream = fs.createWriteStream(fileList)
  for (const filename of filenames) {
    writeStream.write(`${filename}\n`)
  }
  writeStream.end()
}

/**
 * Writes a listing that carries the directory structure, either as flat
 * `directory/` headers or as an indented tree.
 *
 * @param {string} listType
 * @param {string} fileList
 * @param {string[]} filenames
 */
export function writeFullTree (listType, fileList, filenames) {
  let currentDirectory = ''
  let level = (listType === LIST_TYPES.flatTree) ? 1 : 0
  const writeStream = fs.createWriteStream(fileList)

  for (const filename of filenames) {
    const directory = path.dirname(filename)
    if (directory !== currentDirectory) {
      if (listType === LIST_TYPES.flatTree) {
        writeStream.write(`${directory}/\n`)
      } else {
        const { newLevel, parts } = findNewParts(currentDirectory, directory)
        level = newLevel
        for (const part of parts) {
          writeStream.write(`${buildLevel(level)}${part}/\n`)
          level++
        }
      }
      currentDirectory = directory
    }

    writeStream.write(`${buildLevel(level)}${path.basename(filename)}\n`)
  }

  writeStream.end()
}
