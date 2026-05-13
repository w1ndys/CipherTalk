#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const distEntry = join(root, 'dist', 'index.js')

if (existsSync(distEntry)) {
  await import(pathToFileURL(distEntry).href)
} else {
  await import('tsx/esm')
  await import(pathToFileURL(join(root, 'src', 'index.ts')).href)
}
