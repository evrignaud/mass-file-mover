/**
 * Default number of file operations kept in flight at once.
 *
 * The original implementation started a rename for every entry of the list at
 * the same moment, which on a large tree runs the process out of file
 * descriptors. A small fixed pool keeps the throughput without that risk.
 */
export const DEFAULT_CONCURRENCY = 8

/**
 * Runs `worker` over `items` with at most `limit` calls in flight, preserving
 * the order in which items are picked up.
 *
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<void>} worker
 * @returns {Promise<void>}
 */
export async function mapWithConcurrency (items, limit, worker) {
  const poolSize = Math.max(1, Math.min(limit, items.length))
  let cursor = 0

  const runners = Array.from({ length: poolSize }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      await worker(items[index], index)
    }
  })

  await Promise.all(runners)
}
