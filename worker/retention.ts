import { DAY } from './constants.ts';
import { requireDatabase } from './db.ts';
import type { Env } from './env.ts';

// Opportunistic physical cleanup. Inbox, group updates and confirmed sent text
// expire after seven days; send and reaction operation records after thirty.
export async function cleanup(env: Env, now: number): Promise<void> {
  const db = requireDatabase(env);
  await db.batch([
    db.prepare('DELETE FROM inbox WHERE received_at<?').bind(now - 7 * DAY),
    db.prepare('DELETE FROM outgoing WHERE created_at<?').bind(now - 30 * DAY),
    db.prepare('DELETE FROM reaction_operations WHERE created_at<?').bind(now - 30 * DAY),
    db.prepare('DELETE FROM group_updates WHERE received_at<?').bind(now - 7 * DAY),
    db.prepare('DELETE FROM sent_messages WHERE sent_at<?').bind(now - 7 * DAY),
  ]);
}
