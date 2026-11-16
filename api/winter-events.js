import { readJSON, writeJSON } from '../lib/blobstore.js';
import { put } from '@vercel/blob';

const KEY = 'winterEvents.json';

// Seed data — same 10 locations as summer, dates/venues TBD, plus Maryland as a
// gift-only mailing (no party). Oklahoma's combined $10,000 budget is split into
// two editable rows ($50 x 100 employees each for OKC and Tulsa), tagged with a
// shared budgetGroup purely for display subtotaling.
const SEED = {
  'w-co': { id: 'w-co', state: 'Colorado', city: '', label: 'Colorado', venue: null, address: null, url: null, date: null, time: null, startISO: null, endISO: null, est: 50, giftOnly: false, budgetGroup: null, budgetAllotted: 2500, budgetSpent: 0 },
  'w-okc': { id: 'w-okc', state: 'Oklahoma', city: 'Oklahoma City', label: 'Oklahoma City, OK', venue: null, address: null, url: null, date: null, time: null, startISO: null, endISO: null, est: 100, giftOnly: false, budgetGroup: 'Oklahoma', budgetAllotted: 5000, budgetSpent: 0 },
  'w-tulsa': { id: 'w-tulsa', state: 'Oklahoma', city: 'Tulsa', label: 'Tulsa, OK', venue: null, address: null, url: null, date: null, time: null, startISO: null, endISO: null, est: 100, giftOnly: false, budgetGroup: 'Oklahoma', budgetAllotted: 5000, budgetSpent: 0 },
  'w-raleigh': { id: 'w-raleigh', state: 'North Carolina', city: 'Raleigh', label: 'Raleigh, NC', venue: null, address: null, url: null, date: null, time: null, startISO: null, endISO: null, est: 300, giftOnly: false, budgetGroup: 'North Carolina', budgetAllotted: 15000, budgetSpent: 0 },
  'w-ncharlotte': { id: 'w-ncharlotte', state: 'North Carolina', city: 'North Charlotte', label: 'North Charlotte, NC', venue: null, address: null, url: null, date: null, time: null, startISO: null, endISO: null, est: 300, giftOnly: false, budgetGroup: 'North Carolina', budgetAllotted: 15000, budgetSpent: 0 },
  'w-omaha': { id: 'w-omaha', state: 'Nebraska', city: 'Omaha', label: 'Nebraska', venue: null, address: null, url: null, date: null, time: null, startISO: null, endISO: null, est: 410, giftOnly: false, budgetGroup: null, budgetAllotted: 20500, budgetSpent: 0 },
  'w-atlanta': { id: 'w-atlanta', state: 'Georgia', city: 'Atlanta', label: 'Atlanta, GA', venue: null, address: null, url: null, date: null, time: null, startISO: null, endISO: null, est: 300, giftOnly: false, budgetGroup: null, budgetAllotted: 15000, budgetSpent: 0 },
  'w-slc': { id: 'w-slc', state: 'Utah', city: 'Salt Lake City', label: 'Utah', venue: null, address: null, url: null, date: null, time: null, startISO: null, endISO: null, est: 50, giftOnly: false, budgetGroup: null, budgetAllotted: 2500, budgetSpent: 0 },
  'w-va': { id: 'w-va', state: 'Virginia', city: '', label: 'Virginia', venue: null, address: null, url: null, date: null, time: null, startISO: null, endISO: null, est: 45, giftOnly: false, budgetGroup: null, budgetAllotted: 2250, budgetSpent: 0, notes: 'Venue TBD: Northern Virginia or Virginia Beach' },
  'w-indiana': { id: 'w-indiana', state: 'Indiana', city: 'Indianapolis', label: 'Indiana', venue: null, address: null, url: null, date: null, time: null, startISO: null, endISO: null, est: 85, giftOnly: false, budgetGroup: null, budgetAllotted: 4250, budgetSpent: 0 },
  'w-maryland': { id: 'w-maryland', state: 'Maryland', city: '', label: 'Maryland', venue: null, address: null, url: null, date: null, time: null, startISO: null, endISO: null, est: null, giftOnly: true, budgetGroup: null, budgetAllotted: null, budgetSpent: 0 },
};

const EDITABLE_FIELDS = ['state', 'city', 'label', 'venue', 'address', 'url', 'date', 'time', 'startISO', 'endISO', 'est', 'giftOnly', 'budgetGroup', 'budgetAllotted', 'budgetSpent', 'notes', 'plBcc', 'flyerUrl'];

/**
 * Winter event metadata store — replaces the hardcoded-array pattern used for
 * summer so dates/venues/budget can be filled in from the dashboard with no
 * code deploy (all 10 winter events start with TBD dates/venues).
 * GET  -> { events: [ {...}, ... ] }  (public, seeded on first read if empty)
 * POST (passcode) -> { id, ...fieldsToMerge }  — upserts one event by id,
 *   merging only the provided fields. { id: "new-id", ...fullRecord } creates one.
 */
export default async function handler(req, res) {
  if (req.method === 'GET') {
    let all = await readJSON(KEY, null);
    if (!all) { all = SEED; await writeJSON(KEY, all); }
    return res.status(200).json({ events: Object.values(all) });
  }

  if (req.method === 'POST') {
    const pass = process.env.SEND_PASSCODE;
    if (!pass) return res.status(501).json({ error: 'SEND_PASSCODE not configured.' });
    if ((req.headers['x-send-passcode'] || '') !== pass) return res.status(401).json({ error: 'Incorrect passcode.' });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON.' }); } }
    const id = body && body.id;
    if (!id) return res.status(400).json({ error: 'id required.' });

    if (body.action === 'uploadFlyer') {
      const b64 = body.imageBase64;
      if (!b64) return res.status(400).json({ error: 'imageBase64 required.' });
      const contentType = body.contentType || 'image/jpeg';
      const ext = contentType.includes('png') ? 'png' : 'jpg';
      const buf = Buffer.from(b64, 'base64');
      if (buf.length > 1.5 * 1024 * 1024) return res.status(400).json({ error: 'Image too large for email (keep under 1.5MB, ideally under 150KB).' });
      const blob = await put(`flyers/${id}.${ext}`, buf, { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType });
      let all = await readJSON(KEY, null);
      if (!all) all = SEED;
      const existing = all[id] || { id };
      all[id] = { ...existing, id, flyerUrl: blob.url };
      await writeJSON(KEY, all);
      return res.status(200).json({ ok: true, id, flyerUrl: blob.url });
    }

    let all = await readJSON(KEY, null);
    if (!all) all = SEED;
    const existing = all[id] || { id };
    const merged = { ...existing, id };
    for (const k of EDITABLE_FIELDS) { if (k in body) merged[k] = body[k]; }
    all[id] = merged;
    await writeJSON(KEY, all);
    return res.status(200).json({ ok: true, id, event: merged });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed.' });
}
