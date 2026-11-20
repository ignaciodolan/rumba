import { lstat, readdir, readlink } from 'node:fs/promises'
import path from 'node:path'

// Reading a directory that an agent, or code in a container, wrote to. Nothing here follows
// a link or runs anything: entries are listed and links are read as text.

/** Characters HFS+ ignores in a file name, which would let another spelling name the same entry. */
const HFS_IGNORABLE = /[‌-‏‪-‮⁪-⁯﻿]/g

/** Whether a file system could take `name` for `.git`: any letter case, HFS+ ignorable characters, the NTFS short name. */
function isDotGit(name: string): boolean {
  const folded = name.replace(HFS_IGNORABLE, '').toLowerCase()
  return folded === '.git' || folded === 'git~1'
}

/**
 * Entries named `.git` below `root`, as paths from it: a folder, a file or a link, at any
 * depth, also inside folders git would ignore. The root's own `.git` is not one of them. A
 * folder that cannot be listed is reported too, since nothing can be said about it.
 */
export async function nestedGitEntries(root: string, limit = 5): Promise<string[]> {
  const found: string[] = []
  const pending: string[] = ['']
  while (pending.length > 0 && found.length < limit) {
    const dir = pending.pop()!
    let entries
    try {
      entries = await readdir(path.join(root, dir), { withFileTypes: true })
    } catch {
      found.push(`${dir} (cannot be read)`)
      continue
    }
    for (const entry of entries) {
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`
      if (isDotGit(entry.name)) {
        if (dir !== '') found.push(rel)
      } else if (entry.isDirectory()) {
        pending.push(rel)
      }
    }
  }
  return found.slice(0, limit)
}

const MAX_LINK_HOPS = 40

/**
 * Where the path `file` (from `root`, with `/` separators) really leads, following every
 * symbolic link on the way as the kernel would, but by reading link texts, never by letting
 * the kernel follow one.
 * - `outside`: it climbs above `root`, meets an absolute target, or loops.
 * - `person`: it reaches a link for which `personOut` is true, a link a person committed
 *   that points outside.
 * - `inside`: it ends at or below `root`. A part that does not exist is taken as written.
 */
export async function resolveLink(root: string, file: string, personOut: (file: string) => boolean): Promise<'inside' | 'outside' | 'person'> {
  const reached: string[] = []
  const todo = file.split('/')
  let hops = 0
  while (todo.length > 0) {
    const part = todo.shift()!
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (reached.length === 0) return 'outside'
      reached.pop()
      continue
    }
    const here = [...reached, part]
    const stat = await lstat(path.join(root, ...here)).catch(() => null)
    if (stat === null || !stat.isSymbolicLink()) {
      reached.push(part)
      continue
    }
    hops += 1
    if (hops > MAX_LINK_HOPS) return 'outside'
    if (here.join('/') !== file && personOut(here.join('/'))) return 'person'
    const target = await readlink(path.join(root, ...here)).catch(() => '/')
    if (path.posix.isAbsolute(target)) return 'outside'
    // A relative target starts from the folder that holds the link, which is `reached`.
    todo.unshift(...target.split('/'))
  }
  return 'inside'
}
