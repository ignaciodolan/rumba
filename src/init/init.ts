import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isValidRumbaName } from '../core/labels.js'

const TEMPLATES = fileURLToPath(new URL('./templates/', import.meta.url))
const WORKFLOW = '.github/workflows/rumba.yml'
const MANAGED = '# managed by rumba init'
const MATRIX_LINE = /^(\s*)rumba:\s*\[([^\]\n]*)\][ \t]*$/m

const CI_NOTE =
  'Pull requests opened with the default GitHub Actions token do not start this repository\'s own CI. ' +
  'Set RUMBA_GITHUB_TOKEN to a fine-grained token or a GitHub App token to get CI on Rumba\'s pull requests.'

const PACKAGE_NOTE =
  'The workflow runs `npx rumba-cli`, but rumba-cli is not published to npm yet, and until the name is taken anyone could publish a package under it. ' +
  'Do not enable the workflow until rumba-cli is published, or replace its "Run rumba" step with an install from a checkout of Rumba you trust.'

const PULL_REQUEST_NOTE =
  'With the default GitHub Actions token, turn on the repository setting "Allow GitHub Actions to create and approve pull requests" ' +
  '(Settings, Actions, General). Without it, opening the pull request fails after all the work is done.'

const DOCKER_NOTE =
  'With the docker environment, Rumba runs `up`, `exec` and `down` from a checkout of the default branch and puts the path of the code under test in RUMBA_WORKDIR. ' +
  'Mount that path in your compose file, for example `${RUMBA_WORKDIR:-.}:/app`, and merge that change to the default branch before the first run.'

async function template(file: string, name: string): Promise<string> {
  return (await readFile(path.join(TEMPLATES, file), 'utf8')).replaceAll('__NAME__', name)
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
}

/** Adds `name` to the matrix of a workflow `rumba init` wrote; null when the file is not one it can change. */
function addToMatrix(workflow: string, name: string): string | null {
  if (!workflow.startsWith(MANAGED)) return null
  const m = MATRIX_LINE.exec(workflow)
  if (!m) return null
  const names = m[2].split(',').map((n) => n.trim()).filter((n) => n !== '')
  if (!names.includes(name)) names.push(name)
  return workflow.replace(MATRIX_LINE, `${m[1]}rumba: [${names.join(', ')}]`)
}

/** Creates `.rumba/<name>/` with starter files and, if there is none, the scheduled workflow. */
export async function initRumba(repoRoot: string, name: string): Promise<{ created: string[]; notes: string[] }> {
  if (!isValidRumbaName(name)) {
    throw new Error(`${name}: a rumba name may only use lowercase letters, digits and hyphens (for example "my-app")`)
  }
  const dir = path.join(repoRoot, '.rumba', name)
  await mkdir(path.dirname(dir), { recursive: true })
  try {
    await mkdir(dir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`.rumba/${name} already exists`)
    throw e
  }

  const created: string[] = []
  const notes: string[] = []
  for (const file of ['rumba.yml', 'context.md', 'lessons.md']) {
    await writeFile(path.join(dir, file), await template(file, name), { flag: 'wx' })
    created.push(`.rumba/${name}/${file}`)
  }

  const workflowPath = path.join(repoRoot, WORKFLOW)
  const existing = await readOptional(workflowPath)
  if (existing === undefined) {
    await mkdir(path.dirname(workflowPath), { recursive: true })
    await writeFile(workflowPath, (await template('workflow.yml', name)).replace('__NAMES__', name), { flag: 'wx' })
    created.push(WORKFLOW)
  } else {
    const updated = addToMatrix(existing, name)
    if (updated === null) {
      notes.push(`${WORKFLOW} already exists and was not written by rumba init, so add "${name}" to its rumba matrix by hand.`)
    } else if (updated !== existing) {
      await writeFile(workflowPath, updated)
      notes.push(`Added "${name}" to the rumba matrix in ${WORKFLOW}.`)
    }
  }

  notes.push(DOCKER_NOTE, PACKAGE_NOTE, PULL_REQUEST_NOTE, CI_NOTE)
  return { created, notes }
}
