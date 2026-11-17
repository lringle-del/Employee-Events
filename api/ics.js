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

// UTC offset ("-06:00") that `tz` has at the given local wall-clock time, so the
// Outlook link can pin the party to its own time zone (handles daylight saving).
function zoneOffset(localISO, tz) {
  const t = Date.parse(localISO + 'Z');
  const parts = {};
  new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(t)).forEach((p) => { parts[p.type] = p.value; });
  const asLocal = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const mins = Math.round((asLocal - t) / 60000);
  const a = Math.abs(mins);
  return (mins < 0 ? '-' : '+') + String(Math.floor(a / 60)).padStart(2, '0') + ':' + String(a % 60).padStart(2, '0');
}

export default async function handler(req, res) {
  const eventId = (req.query && req.query.eventId) || '';
  if (!eventId) return res.status(400).json({ error: 'eventId required.' });

  const events = await readJSON(KEY, {});
  const e = events[eventId];
  if (!e) return res.status(404).json({ error: 'No such event.' });
  if (!e.startISO) return res.status(409).json({ error: 'This event’s date/time isn’t set yet.' });

  const location = [e.venue, e.address].filter(Boolean).join(', ');
  // End time is optional. With none, use a 1-hour block rather than a zero-length event,
  // which some calendar apps show as a thin line or drop.
  const endISO = e.endISO || new Date(Date.parse(e.startISO + 'Z') + 3600000).toISOString().slice(0, 19);
  const title = (e.city || e.state) + ' Winter Appreciation Party';

  // ?outlook=1 -> Outlook on the web's "new event" screen with everything filled in.
  // Downloaded .ics files often do nothing when clicked from Outlook desktop.
  if (req.query && req.query.outlook) {
    const tz = STATE_TZ[e.state];
    const at = (iso) => (tz ? iso + zoneOffset(iso, tz) : iso);
    const params = new URLSearchParams({ path: '/calendar/action/compose', rru: 'addevent', subject: title, startdt: at(e.startISO), enddt: at(endISO) });
    if (location) params.set('location', location);
    if (e.url) params.set('body', e.url);
    res.setHeader('location', 'https://outlook.office.com/calendar/0/deeplink/compose?' + params.toString());
    return res.status(302).end();
  }

  // ?google=1 -> send the person straight to Google Calendar's "add event" screen with
  // everything filled in (a downloaded .ics file never opens Google Calendar by itself).
  // Both of these live in this function rather than new ones: the project is at Vercel's
  // 12-function limit on the Hobby plan.
  if (req.query && req.query.google) {
    const params = new URLSearchParams({
      action: 'TEMPLATE',
      text: title,
      dates: stamp(e.startISO) + '/' + stamp(endISO),
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
    'DTEND:' + stamp(endISO),
    'SUMMARY:' + fold(title),
    location ? 'LOCATION:' + fold(location) : null,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean).join('\r\n') + '\r\n'; // spec: every line, including the last, ends in CRLF

  // "inline" lets iPhone/iPad open the add-to-Calendar sheet straight away; an
  // "attachment" is just saved to Downloads and nothing opens.
  res.setHeader('content-type', 'text/calendar; charset=utf-8');
  res.setHeader('content-disposition', 'inline; filename="' + eventId + '.ics"');
  return res.status(200).send(ics);
}
