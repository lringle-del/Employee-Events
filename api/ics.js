import { readJSON } from '../lib/blobstore.js';

const KEY = 'winterEvents.json';

// Minimal RFC5545 VEVENT, floating local time (no TZID) since each event is
// single-timezone — most calendar clients render it "as entered."
const fold = (s) => String(s).replace(/[\n,;]/g, (c) => ({ '\n': '\\n', ',': '\\,', ';': '\\;' }[c]));
const stamp = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d{3}Z?$/, '').slice(0, 15);

export default async function handler(req, res) {
  const eventId = (req.query && req.query.eventId) || '';
  if (!eventId) return res.status(400).json({ error: 'eventId required.' });

  const events = await readJSON(KEY, {});
  const e = events[eventId];
  if (!e) return res.status(404).json({ error: 'No such event.' });
  if (!e.startISO || !e.endISO) return res.status(409).json({ error: 'This event’s date/time isn’t set yet.' });

  const location = [e.venue, e.address].filter(Boolean).join(', ');
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Above & Beyond ABA//Winter Holiday Parties//EN',
    'BEGIN:VEVENT',
    'UID:' + eventId + '@abtaba.com',
    'DTSTAMP:' + stamp(new Date().toISOString()) + 'Z',
    'DTSTART:' + stamp(e.startISO),
    'DTEND:' + stamp(e.endISO),
    'SUMMARY:' + fold((e.city || e.state) + ' Winter Appreciation Party'),
    location ? 'LOCATION:' + fold(location) : null,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');

  res.setHeader('content-type', 'text/calendar; charset=utf-8');
  res.setHeader('content-disposition', 'attachment; filename="' + eventId + '.ics"');
  return res.status(200).send(ics);
}
