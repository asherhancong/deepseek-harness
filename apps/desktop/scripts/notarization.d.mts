import type { Checkpoint, Receipt, ReleaseIdentity } from './release-state.mjs'

/** Apple command boundary; completion means the subprocess has exited. */
export type AppleCommand = (file: string, args: string[], timeout?: number) => string | Promise<string>

/** Validate persisted identity and archive bytes before returning the checkpoint. */
export function readCheckpoint(directory: string, expected: ReleaseIdentity): Promise<Checkpoint>

/** Persist one submission receipt; resume and repeated attempts reject before submission. */
export function submitArchive(
  directory: string, expected: ReleaseIdentity, arch: string,
  env?: NodeJS.ProcessEnv, run?: AppleCommand,
): Promise<Receipt>

/** Query recorded IDs only; return false while Apple is pending and reject invalid state. */
export function checkSubmissions(
  directory: string, expected: ReleaseIdentity, env?: NodeJS.ProcessEnv, run?: AppleCommand,
): Promise<boolean>
