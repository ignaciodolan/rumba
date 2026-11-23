import { z } from 'zod'
import type { LabelNames } from '../core/types.js'

/**
 * Files that define the containers. The environment is brought up from the default branch's
 * copy of them, so a change to one in a fix could not be verified anyway; the guard rejects
 * it with a clear reason. This is a second layer: the boundary is where host commands run.
 */
export const DEFAULT_DOCKER_PROTECTED = ['docker-compose*.y*ml', 'compose*.y*ml', 'Dockerfile*', '*.dockerfile', '.dockerignore']

const dockerEnvironment = z.object({
  kind: z.literal('docker'),
  up: z.string().min(1),
  exec: z.string().min(1),
  down: z.string().min(1),
  protected: z.array(z.string()).default(DEFAULT_DOCKER_PROTECTED),
  command_timeout_minutes: z.number().int().positive().default(10),
  min_free_disk_gb: z.number().nonnegative().default(5),
})

/** A Node major version for the sandbox image, from 20 on. It becomes a Docker build argument, so nothing else is allowed. */
const nodeMajor = z
  .union([z.number().int(), z.string()])
  .transform((v) => String(v))
  .refine((v) => /^[0-9]{2,3}$/.test(v) && Number(v) >= 20, { message: 'must be a Node major version from 20 on, such as 24' })

const vercelEnvironment = z.object({
  kind: z.literal('vercel-preview'),
  project_id: z.string().min(1).optional(),
  protected: z.array(z.string()).default([]),
})

export const rumbaFileSchema = z
  .object({
    paths: z.array(z.string().min(1)),
    tracker: z.object({
      kind: z.enum(['github', 'linear']),
      team: z.string().min(1).optional(),
      project: z.string().min(1).optional(),
    }),
    agent: z.object({
      kind: z.enum(['claude-code', 'gemini-cli']),
      model: z.string().min(1).optional(),
    }),
    environment: z.discriminatedUnion('kind', [dockerEnvironment, vercelEnvironment]),
    verify: z.object({ test: z.string().min(1).optional() }).default({}),
    /** relocate: once the change is verified, move Rumba's checks into the project's own tests. */
    checks: z.object({ relocate: z.boolean().default(true) }).default({ relocate: true }),
    sandbox: z.object({ node: nodeMajor.default('22') }).default({ node: '22' }),
    commit_author: z.object({ name: z.string().trim().min(1), email: z.string().trim().regex(/^[^\s<>@]+@[^\s<>@]+$/, 'must be an email address') }).optional(),
    limits: z
      .object({
        max_tickets_per_run: z.number().int().positive().default(3),
        minutes_per_ticket: z.number().int().positive().default(30),
        max_fix_attempts: z.number().int().positive().default(2),
      })
      .default({ max_tickets_per_run: 3, minutes_per_ticket: 30, max_fix_attempts: 2 }),
    labels: z
      .object({
        opt_in: z.string().min(1).optional(),
        state_prefix: z.string().min(1).optional(),
        approved: z.string().min(1).optional(),
        retry: z.string().min(1).optional(),
        revise: z.string().min(1).optional(),
      })
      .default({}),
  })
  .superRefine((v, ctx) => {
    if (v.tracker.kind === 'linear' && !v.tracker.team) {
      ctx.addIssue({ code: 'custom', path: ['tracker', 'team'], message: 'tracker.team is required when tracker.kind is linear' })
    }
  })

export type RumbaFile = z.infer<typeof rumbaFileSchema>
export type LabelOverrides = RumbaFile['labels']

export function mergeLabels(defaults: LabelNames, o: LabelOverrides): LabelNames {
  return {
    optIn: o.opt_in ?? defaults.optIn,
    statePrefix: o.state_prefix ?? defaults.statePrefix,
    approved: o.approved ?? defaults.approved,
    retry: o.retry ?? defaults.retry,
    revise: o.revise ?? defaults.revise,
  }
}
