import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, readFile, readlink } from 'node:fs/promises'
import path from 'node:path'

/** One entry of a commit's tree: its git mode (100644, 100755, 120000, 160000) and object id. */
export interface TreeEntry { mode: string; oid: string }

const CHUNK = 1 << 20

/** The object id git gives a blob with these bytes; SHA-1 or SHA-256 by the length of the ids in use. */
function blobHash(oidLength: number, size: number) {
  return createHash(oidLength === 64 ? 'sha256' : 'sha1').update(`blob ${size}\0`)
}

async function fileOid(file: string, oidLength: number): Promise<{ oid: string; executable: boolean } | null> {
  let handle
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return null
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) return null
    const hash = blobHash(oidLength, stat.size)
    const buffer = Buffer.alloc(Math.min(CHUNK, Math.max(1, stat.size)))
    let read = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
      read += bytesRead
    }
    // A file that grew or shrank while it was read does not match either.
    return read === stat.size ? { oid: hash.digest('hex'), executable: (stat.mode & 0o100) !== 0 } : null
  } finally {
    await handle.close()
  }
}

/**
 * Compares the directory `root` with a commit's tree and returns the paths that differ:
 * changed, missing or added files and links, added folders, a changed executable bit, and a
 * `.git` pointer other than the one git wrote. Empty when the directory is exactly the
 * commit. Nothing is followed or executed: files are read and hashed as git hashes a blob.
 */
export async function compareWithTree(root: string, tree: Map<string, TreeEntry>, pointer: string): Promise<string[]> {
  const differs: string[] = []
  const folders = new Set<string>()
  for (const file of tree.keys()) {
    const parts = file.split('/')
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'))
  }
  const oidLength = tree.values().next().value?.oid.length ?? 40

  const pointerStat = await lstat(path.join(root, '.git')).catch(() => null)
  if (pointerStat === null || !pointerStat.isFile() || (await readFile(path.join(root, '.git'), 'utf8').catch(() => null)) !== pointer) differs.push('.git')

  const seen = new Set<string>()
  const pending: string[] = ['']
  while (pending.length > 0) {
    const dir = pending.pop()!
    let entries
    try {
      entries = await readdir(path.join(root, dir), { withFileTypes: true })
    } catch {
      differs.push(dir === '' ? '.' : dir)
      continue
    }
    for (const entry of entries) {
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`
      if (rel === '.git') continue
      const expected = tree.get(rel)
      const full = path.join(root, rel)
      if (entry.isDirectory()) {
        if (expected?.mode === '160000') {
          // A submodule that is not checked out: an empty folder.
          seen.add(rel)
          if ((await readdir(full).catch(() => ['?'])).length > 0) differs.push(rel)
        } else if (folders.has(rel)) {
          pending.push(rel)
        } else {
          differs.push(rel)
        }
      } else if (expected === undefined) {
        differs.push(rel)
      } else if (entry.isSymbolicLink()) {
        seen.add(rel)
        const target = await readlink(full).catch(() => null)
        const oid = target === null ? null : blobHash(oidLength, Buffer.byteLength(target)).update(target).digest('hex')
        if (expected.mode !== '120000' || oid !== expected.oid) differs.push(rel)
      } else {
        seen.add(rel)
        const actual = entry.isFile() ? await fileOid(full, oidLength) : null
        const wantExecutable = expected.mode === '100755'
        if (actual === null || (expected.mode !== '100644' && expected.mode !== '100755') || actual.oid !== expected.oid || actual.executable !== wantExecutable) differs.push(rel)
      }
    }
  }
  for (const file of tree.keys()) if (!seen.has(file)) differs.push(file)
  return [...new Set(differs)].sort()
}
