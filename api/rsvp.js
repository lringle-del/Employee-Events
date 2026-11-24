import { readJSON, writeJSON } from '../lib/blobstore.js';

const KEY = 'rsvps.json';
const EVENTS_KEY = 'winterEvents.json';
const AUD_KEY = 'audiences.json';
const EMAIL_RX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// The owner's own test submissions should never count toward real RSVP numbers.
const TEST_EMAILS = new Set(['lringle@abtaba.com']);

/**
 * Winter RSVP capture — replaces the Microsoft Forms + manual-export workflow.
 * GET  -> { counts: { eventId: { yes, plusOnes, total } } }  (public, no PII)
 * POST {eventId, name, email, plusOne} -> stores/overwrites the attendee's RSVP
 *   (public, no passcode — real employees submit with no credential).
 * POST {action:'list', eventId} + x-send-passcode -> full named roster for that event.
 */
export default async function handler(req, res) {
  if (req.method === 'GET') {
    const all = await readJSON(KEY, {});
    const counts = {};
    for (const eventId in all) {
      const entries = Object.values(all[eventId]);
      // Records saved before the decline button existed have no status: they're all yeses.
      const going = entries.filter((r) => r.status !== 'no');
      const yes = going.length;
      const plusOnes = going.filter((r) => r.plusOne).length;
      counts[eventId] = { yes, plusOnes, total: yes + plusOnes, no: entries.length - yes };
    }
    // Rosters are included openly (no passcode) -- the user confirmed this should
    // match the Summer RSVP dashboard's always-visible viewing model.
    return res.status(200).json({ counts, rosters: all });
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON.' }); } }

    if (body && (body.action === 'list' || body.action === 'delete')) {
      const pass = process.env.SEND_PASSCODE;
      if (!pass) return res.status(501).json({ error: 'SEND_PASSCODE not configured.' });
      if ((req.headers['x-send-passcode'] || '') !== pass) return res.status(401).json({ error: 'Incorrect passcode.' });
      const eventId = body.eventId;
      if (!eventId) return res.status(400).json({ error: 'eventId required.' });
      const all = await readJSON(KEY, {});
      if (body.action === 'delete') {
        const email = (body.email || '').trim().toLowerCase();
        if (!email) return res.status(400).json({ error: 'email required.' });
        if (all[eventId]) delete all[eventId][email];
        await writeJSON(KEY, all);
        return res.status(200).json({ ok: true, eventId, email });
      }
      return res.status(200).json({ eventId, roster: all[eventId] || {} });
    }

    const eventId = body && body.eventId;
    const email = (body && body.email || '').trim().toLowerCase();
    const name = (body && body.name || '').trim();
    const status = body && body.status === 'no' ? 'no' : 'yes';
    const plusOne = status === 'yes' && !!(body && body.plusOne);
    if (!eventId) return res.status(400).json({ error: 'eventId required.' });
    if (!EMAIL_RX.test(email)) return res.status(400).json({ error: 'A valid email is required.' });
    if (TEST_EMAILS.has(email)) return res.status(200).json({ ok: true, eventId, test: true });

    const events = await readJSON(EVENTS_KEY, {});
    if (!events[eventId]) return res.status(404).json({ error: 'No such event.' });

    const audiences = await readJSON(AUD_KEY, {});
    const roster = audiences['Winter ' + events[eventId].label] || [];
    const knownRoster = roster.map((e) => String(e).toLowerCase()).includes(email);

    const all = await readJSON(KEY, {});
    all[eventId] = all[eventId] || {};
    // Keyed by email, so answering again (e.g. yes, then "can't make it") replaces the earlier answer.
    all[eventId][email] = { name, plusOne, status, knownRoster, respondedAt: new Date().toISOString() };
    await writeJSON(KEY, all);
    return res.status(200).json({ ok: true, eventId });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed.' });
}
