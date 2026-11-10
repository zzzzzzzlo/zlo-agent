import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { maxDiagnosticLineBytes, parseHostDiagnostic, validateDiagnostic } from '../../../shared/diagnostics.ts'
import type { DiagnosticEntry } from '../../../shared/diagnostics.ts'

const defaultMaxFileBytes = 256 * 1024
const archiveCount = 2
const maxPending = 128

async function regularFile(path: string) {
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new Error('Unsafe diagnostic log path')
  return stat
}

export function createDiagnosticLog(directory: string, maxFileBytes = defaultMaxFileBytes) {
  const current = join(directory, 'diagnostics.jsonl')
  let queue = Promise.resolve()
  let pending = 0

  async function rotate() {
    for (let index = archiveCount; index > 0; index--) {
      const source = index === 1 ? current : current + '.' + (index - 1)
      const target = current + '.' + index
      const sourceInfo = await regularFile(source)
      if (await regularFile(target)) await unlink(target)
      if (sourceInfo && sourceInfo.size <= maxFileBytes) await rename(source, target)
      else if (sourceInfo) await unlink(source)
    }
  }

  async function append(bytes: Buffer) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (!(await lstat(directory)).isDirectory()) return
    const info = await regularFile(current)
    if (info && info.size + bytes.length > maxFileBytes) await rotate()
    const file = await open(current, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600)
    try {
      const stat = await file.stat()
      if (stat.isFile() && stat.nlink === 1 && stat.size + bytes.length <= maxFileBytes) await file.writeFile(bytes)
    } finally {
      await file.close()
    }
  }

  return {
    write(value: DiagnosticEntry): void {
      if (pending >= maxPending) return
      try {
        const item = validateDiagnostic(value)
        if (!item) return
        const bytes = Buffer.from(JSON.stringify(item) + '\n')
        if (bytes.length > maxFileBytes) return
        pending++
        queue = queue.then(() => append(bytes)).catch(() => {}).finally(() => { pending-- })
      } catch {
        // Diagnostics are best-effort and cannot change desktop behavior.
      }
    },
    async flush(timeoutMs?: number): Promise<void> {
      if (timeoutMs === undefined) return queue
      let timer: NodeJS.Timeout | undefined
      try {
        await Promise.race([queue, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs) })])
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

export function collectHostDiagnostics(
  stderr: Readable,
  onEntry: (entry: DiagnosticEntry) => void,
  onDiscard: () => void,
): void {
  let fragment = Buffer.alloc(0)
  let oversized = false
  let reportedDiscard = false
  const discard = () => {
    if (reportedDiscard) return
    reportedDiscard = true
    onDiscard()
  }

  stderr.on('data', (chunk: Buffer) => {
    for (let offset = 0; offset < chunk.length;) {
      const newline = chunk.indexOf(0x0a, offset)
      const end = newline < 0 ? chunk.length : newline
      if (!oversized) {
        if (fragment.length + end - offset > maxDiagnosticLineBytes) {
          fragment = Buffer.alloc(0)
          oversized = true
          discard()
        } else {
          fragment = Buffer.concat([fragment, chunk.subarray(offset, end)])
        }
      }
      if (newline < 0) break
      if (fragment.length) {
        const item = parseHostDiagnostic(fragment.toString('utf8'))
        if (item) onEntry(item)
        else discard()
      }
      fragment = Buffer.alloc(0)
      oversized = false
      offset = newline + 1
    }
  })
  stderr.once('end', () => {
    if (fragment.length) discard()
  })
  stderr.on('error', discard)
}
