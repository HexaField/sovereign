// rad CLI wrapper

export interface RadCli {
  exec(args: string[]): Promise<string>
  isAvailable(): Promise<boolean>
}

export function createRadCli(): RadCli {
  throw new Error('not implemented')
}
