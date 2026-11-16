import { readJSON, writeJSON } from '../lib/blobstore.js';

const KEY = 'rsvps.json';

/** ONE-TIME: remove the test@example.com RSVP used to verify api/rsvp.js. Delete after use. */
export default async function handler(req, res) {
  const pass = process.env.SEND_PASSCODE;
  if (!pass || (req.headers['x-send-passcode'] || '') !== pass) return res.status(401).json({ error: 'Unauthorized.' });
  const all = await readJSON(KEY, {});
  if (all['w-slc']) delete all['w-slc']['testperson@example.com'];
  await writeJSON(KEY, all);
  return res.status(200).json({ ok: true, remaining: all });
}
