/** Node-only uuid source kept behind a tiny module so impl.ts stays side-effect-free to read. */
import { randomUUID as nodeRandomUUID } from 'node:crypto'

export function randomUUID(): string {
  return nodeRandomUUID()
}
