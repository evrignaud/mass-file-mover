import fs from 'node:fs'
import path from 'node:path'

import { DELETE_MARKER } from './constants.js'
import { buildNewDirectory, generateFullPath } from './paths.js'
import { isDotFimDir, walkSync } from './walk.js'

const movedFiles = []

/**
 * Indexes every file below `directory` by name and by name-without-extension
 * so a move list entry can be resolved wherever the file happens to live.
 *
 * @param {string} directory
 * @param {string} moveList Path of the move list, excluded from the index.
 * @returns {{ fileList: Record<string, string[]>, withoutExtList: Record<string, string[]> }}
 */
export function makeFileList (directory, moveList) {
  const fileList = {}
  const withoutExtList = {}
  const moveListFilename = path.basename(moveList)

  walkSync(directory, (basedir, filename, stat) => {
    if (stat.isDirectory() || isDotFimDir(basedir)) {
      return
    }

    if (moveListFilename === filename && path.join(basedir, filename) === moveList) {
      return
    }

    if (fileList[filename]) {
      console.log(`WARN: File '${filename}' found several times`)
      fileList[filename].push(basedir)
    } else {
      fileList[filename] = [basedir]
    }

    const withoutExt = path.basename(filename, path.extname(filename))
    if (withoutExtList[withoutExt]) {
      if (!withoutExtList[withoutExt].includes(filename)) {
        withoutExtList[withoutExt].push(filename)
      }
    } else {
      withoutExtList[withoutExt] = [filename]
    }
  })

  return { fileList, withoutExtList }
}

/**
 * Applies a move list: every entry is moved to its new location, entries
 * prefixed with the delete marker are removed, and source directories left
 * empty afterwards are pruned.
 *
 * @param {string} [moveList]
 * @param {string} [directory]
 * @param {string} [baseDestinationDir]
 */
export function moveFiles (moveList = 'fileList', directory = '.', baseDestinationDir) {
  const { fileList, withoutExtList } = makeFileList(directory, moveList)

  const moveListLines = fs.readFileSync(moveList).toString().split('\n')
  let toMove = 0
  let currentDirectory = ''

  function moveFromAllDirectories (filename, newPath) {
    for (const sourceDir of fileList[filename]) {
      const oldPath = path.join(sourceDir, filename)
      toMove++
      moveFile(oldPath, newPath, (err) => {
        if (err) {
          console.log(`ERR: Error moving from '${oldPath}' to '${newPath}'`, err.message)
        }
        toMove--
      })
    }
  }

  for (let newPath of moveListLines) {
    if (!newPath) {
      continue
    }

    if (newPath.startsWith(DELETE_MARKER)) {
      // The file is to be removed, not moved.
      newPath = newPath.slice(DELETE_MARKER.length).trim()
      if (currentDirectory) {
        newPath = path.join(currentDirectory, newPath)
      }
      deleteFile(newPath)
      continue
    }

    if (newPath.endsWith('/')) {
      // It is a directory header.
      currentDirectory = newPath.startsWith(' ')
        ? buildNewDirectory(currentDirectory, newPath)
        : newPath
      continue
    }

    newPath = generateFullPath(baseDestinationDir, currentDirectory, newPath)

    mkdirRecurs(path.resolve(directory, path.dirname(newPath)))

    let managed = false

    const filename = path.basename(newPath)
    if (fileList[filename]) {
      moveFromAllDirectories(filename, newPath)
      managed = true
    }

    if (withoutExtList[filename]) {
      for (const withExtension of withoutExtList[filename]) {
        if (withExtension !== filename) {
          if (fileList[withExtension]) {
            moveFromAllDirectories(withExtension, newPath + path.extname(withExtension))
            managed = true
          } else {
            console.log(`ERR: File '${withExtension}' does not exist`)
          }
        }
      }
    }

    if (!managed) {
      console.log(`ERR: File '${filename}' does not exist`)
    }
  }

  function cleanDirectory () {
    if (toMove === 0) {
      cleanEmptyFoldersRecursively(directory)
    } else {
      setTimeout(cleanDirectory, 500)
    }
  }

  setTimeout(cleanDirectory, 500)
}

/**
 * Creates `dirname` and any missing parent directory.
 *
 * @param {string} dirname
 * @param {string|number} [mode]
 */
export function mkdirRecurs (dirname, mode = '0777') {
  if (!fs.existsSync(dirname)) {
    dirname.split('/').forEach((dir, index, splits) => {
      let parent = splits.slice(0, index).join('/')
      if (!parent) {
        parent = '/'
      }
      const dirPath = path.join(parent, dir)
      if (!fs.existsSync(dirPath)) {
        try {
          fs.mkdirSync(dirPath, mode)
        } catch (error) {
          console.error(`ERR: Cannot create directory ${dirPath}`, error.message)
        }
      }
    })
  }
}

/**
 * Removes a single file, reporting failures without throwing.
 *
 * @param {string} filename
 */
export function deleteFile (filename) {
  try {
    fs.unlinkSync(filename)
    console.log(`Removed file '${filename}'`)
  } catch (error) {
    console.error(`ERR: Cannot remove file ${filename}`, error.message)
  }
}

/**
 * Moves one file, falling back to a copy when source and destination sit on
 * different filesystems.
 *
 * @param {string} oldPath
 * @param {string} newPath
 * @param {(err?: Error) => void} callback
 */
export function moveFile (oldPath, newPath, callback) {
  if (oldPath === newPath || movedFiles.includes(oldPath)) {
    callback()
    return
  }

  movedFiles.push(oldPath)
  newPath = findNonExistingFilename(newPath)

  fs.rename(oldPath, newPath, (err) => {
    if (err) {
      if (err.code === 'EXDEV') {
        moveFileUsingCopy()
      } else {
        callback(err)
      }
    } else {
      console.log(`Moved '${oldPath}' --> '${newPath}'`)
      callback()
    }
  })

  function moveFileUsingCopy () {
    const readStream = fs.createReadStream(oldPath)
    const writeStream = fs.createWriteStream(newPath)

    readStream.on('error', callback)
    writeStream.on('error', callback)

    readStream.on('close', () => {
      console.log(`Moved (using copy) '${oldPath}' --> '${newPath}'`)
      fs.unlink(oldPath, callback)
    })

    readStream.pipe(writeStream)
  }
}

/**
 * Returns `fullPath`, or the first `name-N.ext` variant that is still free,
 * so that an existing file is never overwritten.
 *
 * @param {string} fullPath
 * @returns {string}
 */
export function findNonExistingFilename (fullPath) {
  let count = 0
  let result = fullPath

  while (true) {
    if (!fs.existsSync(result)) {
      return result
    }

    const extname = path.extname(fullPath)
    const basename = path.basename(fullPath, extname)

    count++
    result = `${basename}-${count}${extname}`
  }
}

/**
 * Recursively removes directories that are empty once the moves are done.
 *
 * @param {string} folder
 */
export function cleanEmptyFoldersRecursively (folder) {
  if (!fs.statSync(folder).isDirectory()) {
    return
  }

  let files = fs.readdirSync(folder)
  if (files.length > 0) {
    for (const file of files) {
      cleanEmptyFoldersRecursively(path.join(folder, file))
    }

    // Re-evaluate after pruning sub-folders: the parent may be empty now.
    files = fs.readdirSync(folder)
  }

  if (files.length === 0) {
    fs.rmdirSync(folder)
    console.log(`Removed empty folder '${folder}'`)
  }
}
