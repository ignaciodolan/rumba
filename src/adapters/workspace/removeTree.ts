import { existsSync } from 'node:fs'
import { rmdir } from 'node:fs/promises'
import { execa } from 'execa'

// Deleting a directory tree that something may still be writing to: a container that did not
// stop still has the checkout mounted. A walk by path can be led outside the tree: the writer
// swaps a folder for a link to any host folder between the moment the walker sees a folder
// and the moment it lists it, and the walker then deletes that folder's files. Node's `fs.rm`
// and the system's `rm -rf` on macOS were both shown to do this.
//
// The walker below never deletes by a path that runs through a name the writer can change.
// It makes a directory its working directory, checks by device and inode number that it is
// the directory it meant to enter, and only then removes entries by their bare names. A bare
// name is looked up in the working directory itself, and removing an entry never follows a
// link. A directory it enters was, when it was seen, a real folder inside the tree, and code
// in a container can only move things around inside its own mount, so everything removed is
// inside the tree. When it finds itself somewhere else, it has removed nothing there; it goes
// back in from the root, checking every step, and gives up if it cannot.
//
// It runs in a child process, because the working directory belongs to the whole process.
const WALKER = String.raw`
const fs = require('node:fs')
const root = process.argv[1]
const big = { bigint: true }
const same = (a, b) => a.dev === b.dev && a.ino === b.ino
const rootStat = fs.lstatSync(root, big)
if (!rootStat.isDirectory()) process.exit(3)
/** The folders from the root down to the one being emptied, each with what it looked like when it was seen. */
const chain = []
function enter() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.chdir(root)
      if (!same(fs.statSync('.', big), rootStat)) continue
      let ok = true
      for (const [name, seen] of chain) {
        process.chdir(name)
        if (!same(fs.statSync('.', big), seen)) { ok = false; break }
      }
      if (ok) return
    } catch {}
  }
  throw new Error('could not stay inside the tree')
}
/** Empties the working directory, which has been checked to be the folder at the end of the chain. */
function empty() {
  for (let pass = 0; pass < 50; pass++) {
    const names = fs.readdirSync('.')
    if (names.length === 0) return
    for (const name of names) {
      let seen
      try { seen = fs.lstatSync(name, big) } catch { continue }
      if (!seen.isDirectory()) {
        try { fs.unlinkSync(name) } catch {}
        continue
      }
      let inside = false
      try {
        process.chdir(name)
        inside = same(fs.statSync('.', big), seen)
      } catch {}
      if (inside) {
        chain.push([name, seen])
        try { empty() } finally { chain.pop() }
      }
      enter()
      try { fs.rmdirSync(name) } catch {}
    }
  }
  throw new Error('the tree kept changing')
}
enter()
empty()
`

/** Deletes a directory tree without ever deleting outside it. Throws when something is left. */
export async function removeTree(dir: string): Promise<void> {
  if (!existsSync(dir)) return
  const walked = await execa(process.execPath, ['-e', WALKER, dir], { cwd: '/', stdin: 'ignore', reject: false, env: { NODE_OPTIONS: '' } })
  await rmdir(dir).catch(() => undefined)
  if (existsSync(dir)) throw new Error(`${dir} could not be removed${walked.stderr ? `: ${String(walked.stderr).split('\n').at(-1)}` : ''}`)
}
