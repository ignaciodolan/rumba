import type { LabelNames, StateName } from './types.js'

export function defaultLabels(rumba: string): LabelNames {
  return { optIn: `rumba:${rumba}`, statePrefix: 'rumba-state:', approved: 'rumba-approved', retry: 'rumba-retry' }
}

export function stateLabel(l: LabelNames, s: StateName): string {
  return `${l.statePrefix}${s}`
}

export function fixBranch(rumba: string, ticketId: string): string {
  return `rumba/${rumba}/${ticketId}`
}

export function baseBranch(rumba: string, ticketId: string): string {
  return `rumba/${rumba}/base-${ticketId}`
}

export function baseBranchOf(fixBranchName: string): string {
  const i = fixBranchName.lastIndexOf('/')
  return `${fixBranchName.slice(0, i + 1)}base-${fixBranchName.slice(i + 1)}`
}

export function isValidRumbaName(name: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)
}
