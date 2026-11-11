import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { safeStorage } from 'electron'

export function storageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text')
}

export async function readEncryptedJson(path: string): Promise<unknown> {
  const file = await open(path, 'r').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!file) return undefined
  try {
    if (!storageAvailable()) throw new Error('Encrypted storage unavailable')
    const info = await file.stat()
    if (!info.isFile() || !info.size || info.size > 512 * 1024) throw new Error('Invalid encrypted file')
    return JSON.parse(safeStorage.decryptString(await file.readFile()))
  } finally {
    await file.close()
  }
}

export async function writeEncryptedJson(path: string, value: unknown): Promise<void> {
  if (!storageAvailable()) throw new Error('Encrypted storage unavailable')
  const data = safeStorage.encryptString(JSON.stringify(value))
  if (data.byteLength > 512 * 1024) throw new Error('Encrypted store is full')
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `${randomUUID()}.encrypted.tmp`)
  const file = await open(temporary, 'wx', 0o600)
  try {
    try {
      await file.writeFile(data)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}
