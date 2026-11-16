import { readJSON, writeJSON } from '../lib/blobstore.js';

const KEY = 'rsvps.json';
const EVENTS_KEY = 'winterEvents.json';
const AUD_KEY = 'audiences.json';
const EMAIL_RX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

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
      const yes = entries.length;
      const plusOnes = entries.filter((r) => r.plusOne).length;
      counts[eventId] = { yes, plusOnes, total: yes + plusOnes };
    }
    return res.status(200).json({ counts });
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON.' }); } }

    if (body && body.action === 'list') {
      const pass = process.env.SEND_PASSCODE;
      if (!pass) return res.status(501).json({ error: 'SEND_PASSCODE not configured.' });
      if ((req.headers['x-send-passcode'] || '') !== pass) return res.status(401).json({ error: 'Incorrect passcode.' });
      const eventId = body.eventId;
      if (!eventId) return res.status(400).json({ error: 'eventId required.' });
      const all = await readJSON(KEY, {});
      return res.status(200).json({ eventId, roster: all[eventId] || {} });
    }

    const eventId = body && body.eventId;
    const email = (body && body.email || '').trim().toLowerCase();
    const name = (body && body.name || '').trim();
    const plusOne = !!(body && body.plusOne);
    if (!eventId) return res.status(400).json({ error: 'eventId required.' });
    if (!EMAIL_RX.test(email)) return res.status(400).json({ error: 'A valid email is required.' });

    const events = await readJSON(EVENTS_KEY, {});
    if (!events[eventId]) return res.status(404).json({ error: 'No such event.' });

    const audiences = await readJSON(AUD_KEY, {});
    const roster = audiences['Winter ' + events[eventId].label] || [];
    const knownRoster = roster.map((e) => String(e).toLowerCase()).includes(email);

    const all = await readJSON(KEY, {});
    all[eventId] = all[eventId] || {};
    all[eventId][email] = { name, plusOne, knownRoster, respondedAt: new Date().toISOString() };
    await writeJSON(KEY, all);
    return res.status(200).json({ ok: true, eventId });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed.' });
}
