import { describe, expect, it } from 'vitest'

import { DEFAULT_CONCURRENCY, mapWithConcurrency } from '../src/concurrency.js'

describe('mapWithConcurrency', () => {
  it('visits every item exactly once', async () => {
    const items = Array.from({ length: 50 }, (_, index) => index)
    const seen = []

    await mapWithConcurrency(items, 8, async (item) => {
      seen.push(item)
    })

    expect(seen.sort((a, b) => a - b)).toEqual(items)
  })

  it('passes the index alongside the item', async () => {
    const pairs = []

    await mapWithConcurrency(['a', 'b', 'c'], 1, async (item, index) => {
      pairs.push([item, index])
    })

    expect(pairs).toEqual([['a', 0], ['b', 1], ['c', 2]])
  })

  it('never exceeds the requested number in flight', async () => {
    let inFlight = 0
    let peak = 0

    await mapWithConcurrency(Array.from({ length: 40 }), 5, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight--
    })

    expect(peak).toBeLessThanOrEqual(5)
    expect(peak).toBeGreaterThan(1)
  })

  it('runs one at a time when the limit is one', async () => {
    let inFlight = 0
    let peak = 0

    await mapWithConcurrency(Array.from({ length: 10 }), 1, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight--
    })

    expect(peak).toBe(1)
  })

  it('copes with an empty list', async () => {
    await expect(mapWithConcurrency([], 8, async () => {
      throw new Error('should never run')
    })).resolves.toBeUndefined()
  })

  it('treats a limit below one as one', async () => {
    const seen = []

    await mapWithConcurrency([1, 2], 0, async (item) => {
      seen.push(item)
    })

    expect(seen).toEqual([1, 2])
  })

  it('exposes a sensible default', () => {
    expect(DEFAULT_CONCURRENCY).toBeGreaterThan(0)
  })
})
