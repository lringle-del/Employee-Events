import { readJSON } from '../lib/blobstore.js';

const KEY = 'winterEvents.json';

// Minimal RFC5545 VEVENT, floating local time (no TZID) since each event is
// single-timezone — most calendar clients render it "as entered."
const fold = (s) => String(s).replace(/[\n,;]/g, (c) => ({ '\n': '\\n', ',': '\\,', ';': '\\;' }[c]));
const stamp = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d{3}Z?$/, '').slice(0, 15);

// Time zone each party's clock time is in, so the Google Calendar link shows it at
// the party's local time no matter where the person's own calendar is set.
const STATE_TZ = {
  Colorado: 'America/Denver', Utah: 'America/Denver',
  Oklahoma: 'America/Chicago', Nebraska: 'America/Chicago',
  'North Carolina': 'America/New_York', Georgia: 'America/New_York',
  Virginia: 'America/New_York', Maryland: 'America/New_York',
  Indiana: 'America/Indiana/Indianapolis',
};

export default async function handler(req, res) {
  const eventId = (req.query && req.query.eventId) || '';
  if (!eventId) return res.status(400).json({ error: 'eventId required.' });

  const events = await readJSON(KEY, {});
  const e = events[eventId];
  if (!e) return res.status(404).json({ error: 'No such event.' });
  if (!e.startISO) return res.status(409).json({ error: 'This event’s date/time isn’t set yet.' });

  const location = [e.venue, e.address].filter(Boolean).join(', ');

  // ?google=1 -> send the person straight to Google Calendar's "add event" screen with
  // everything filled in (a downloaded .ics file never opens Google Calendar by itself).
  // This lives in this function rather than a new one: the project is at Vercel's
  // 12-function limit on the Hobby plan.
  if (req.query && req.query.google) {
    const end = e.endISO || new Date(Date.parse(e.startISO + 'Z') + 3600000).toISOString();
    const params = new URLSearchParams({
      action: 'TEMPLATE',
      text: (e.city || e.state) + ' Winter Appreciation Party',
      dates: stamp(e.startISO) + '/' + stamp(end),
    });
    if (location) params.set('location', location);
    if (STATE_TZ[e.state]) params.set('ctz', STATE_TZ[e.state]);
    if (e.url) params.set('details', e.url);
    res.setHeader('location', 'https://calendar.google.com/calendar/render?' + params.toString());
    return res.status(302).end();
  }

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Above & Beyond ABA//Winter Holiday Parties//EN',
    'BEGIN:VEVENT',
    'UID:' + eventId + '@abtaba.com',
    'DTSTAMP:' + stamp(new Date().toISOString()) + 'Z',
    'DTSTART:' + stamp(e.startISO),
    // End time is optional. With none, ask for a 1-hour block rather than a zero-length
    // event, which some calendar apps show as a thin line or drop.
    e.endISO ? 'DTEND:' + stamp(e.endISO) : 'DURATION:PT1H',
    'SUMMARY:' + fold((e.city || e.state) + ' Winter Appreciation Party'),
    location ? 'LOCATION:' + fold(location) : null,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');

  res.setHeader('content-type', 'text/calendar; charset=utf-8');
  res.setHeader('content-disposition', 'attachment; filename="' + eventId + '.ics"');
  return res.status(200).send(ics);
}
