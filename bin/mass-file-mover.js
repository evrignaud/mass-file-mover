#!/usr/bin/env node

import process from 'node:process'

import { run } from '../src/cli.js'

try {
  process.exitCode = await run()
} catch (error) {
  console.error(`ERR: ${error.message}`)
  process.exitCode = 1
}
