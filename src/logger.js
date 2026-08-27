import pc from 'picocolors'

/**
 * How much a run is allowed to say.
 *
 * - `quiet`   errors and the closing summary only
 * - `normal`  every action taken, plus warnings
 * - `verbose` also what was skipped and why
 */
export const LOG_LEVELS = {
  quiet: 0,
  normal: 1,
  verbose: 2
}

/**
 * Builds the logger threaded through the commands.
 *
 * @param {object} [options]
 * @param {keyof LOG_LEVELS} [options.level]
 * @param {boolean} [options.color] Force colours on or off. Left undefined,
 *   picocolors decides from the terminal and from NO_COLOR.
 * @param {(line: string) => void} [options.write] Sink for regular output.
 * @param {(line: string) => void} [options.writeError] Sink for errors.
 */
export function createLogger ({
  level = 'normal',
  color,
  write = (line) => console.log(line),
  writeError = (line) => console.error(line)
} = {}) {
  const threshold = LOG_LEVELS[level] ?? LOG_LEVELS.normal
  const colors = pc.createColors(color ?? pc.isColorSupported)

  return {
    level,
    threshold,

    /** Always reported, on stderr. */
    error (message) {
      writeError(`${colors.red('ERR')}: ${message}`)
    },

    /** Reported unless quiet, on stderr so it cannot pollute a listing. */
    warn (message) {
      if (threshold >= LOG_LEVELS.normal) {
        writeError(`${colors.yellow('WARN')}: ${message}`)
      }
    },

    /** One line per action taken. */
    info (message) {
      if (threshold >= LOG_LEVELS.normal) {
        write(message)
      }
    },

    /** Detail that only a verbose run wants. */
    debug (message) {
      if (threshold >= LOG_LEVELS.verbose) {
        write(colors.dim(message))
      }
    },

    /** The closing summary, reported even when quiet. */
    out (message) {
      write(message)
    },

    colors
  }
}

/**
 * A logger that says nothing, handy for tests and for library use.
 */
export const silentLogger = createLogger({
  level: 'quiet',
  color: false,
  write: () => {},
  writeError: () => {}
})
