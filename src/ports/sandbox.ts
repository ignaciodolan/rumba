export interface Sandbox {
  run(o: {
    workdir: string
    command: string[]
    env: Record<string, string>
    timeoutMs: number
  }): Promise<{ exitCode: number; output: string }>
}
