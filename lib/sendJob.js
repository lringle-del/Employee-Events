import { Resend } from 'resend';
import crypto from 'crypto';

const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

const RSVP_URL = 'https://forms.cloud.microsoft/Pages/ResponsePage.aspx?id=Mroc1uTzJEKDyxHCW7gZ0jjOWHonDFNFp2Wp8sxbuP5UOFpCRFVCSTlITVE3TlJRUTBXUEI1SzE0US4u';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const rsvpButton = (url) => '<a href="' + url + '" style="display:inline-block;background:#2f9e6f;color:#fff;text-decoration:none;'
  + 'padding:14px 28px;border-radius:10px;font-weight:700;font-size:16px;margin:4px 0">I\'m RSVPing!</a>';
const calButton = (url) => '<a href="' + url + '" style="display:inline-block;background:#2f8fc9;color:#fff;text-decoration:none;'
  + 'padding:12px 24px;border-radius:10px;font-weight:700;font-size:14px;margin:4px 0">'
  + (/[?&](amp;)?google=1/.test(url) ? '📅 Add to Google Calendar' : '📅 Add to Outlook / Apple Calendar') + '</a>';

// Render a plain-text body as HTML: make URLs clickable, turn an /rsvp.html link
// into a real "I'm RSVPing!" button, show the old Forms RSVP link as bold text,
// and turn newlines into line breaks. The flyer (if any) goes on as a real
// attachment instead -- see sendJob() -- not embedded inline here.
function toHtml(body) {
  let h = esc(body);
  h = h.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#1c6fd6">$1</a>');
  h = h.replace('RSVP here: <a href="' + RSVP_URL + '" style="color:#1c6fd6">' + RSVP_URL + '</a>',
    '<a href="' + RSVP_URL + '" style="color:#1c6fd6;font-weight:700">RSVP here</a>');
  h = h.replace(/<a href="(https?:\/\/[^"]*\/rsvp\.html\?event=[^"]*)" style="color:#1c6fd6">\1<\/a>/g,
    (full, url) => rsvpButton(url));
  h = h.replace(/<a href="(https?:\/\/[^"]*\/api\/ics\?eventId=[^"]*)" style="color:#1c6fd6">\1<\/a>/g,
    (full, url) => calButton(url));
  h = h.replace(/\n/g, '<br>');
  return '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.6;color:#222">' + h + '</div>';
}

// Which stored invite list a job sends to. Winter events (ids start "w-") keep
// their rosters under "Winter <label>" -- that's what the winter dashboard's
// Upload button saves -- while summer events use the bare label. Without this,
// a winter job would silently send to the old summer list for the same city.
export const audienceKey = (job) => (job.eventId && String(job.eventId).startsWith('w-') ? 'Winter ' + job.label : job.label);

// Unguessable approval token for a job id (HMAC with CRON_SECRET).
export function tokenFor(id) {
  return crypto.createHmac('sha256', process.env.CRON_SECRET || 'x').update(String(id)).digest('hex').slice(0, 32);
}

// Send one approved job to its real recipients. Attendee -> BCC chunks (director
// BCC'd once on att3/att0). PL -> to the PL, BCC the state director.
export async function sendJob(job, { directors, audiences }) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const baseFrom = process.env.RESEND_FROM;
  // Optional per-job display name + address (e.g. a state director's name and
  // their own address under the verified sending domain) -- distinct addresses
  // per sender avoid mail clients collapsing/mislabeling same-address senders
  // with different display names (seen with Outlook when 3 directors shared
  // one address). The domain itself stays the verified one; only the local
  // part changes, so deliverability/authentication is unaffected.
  const defaultAddr = (baseFrom.match(/<([^>]+)>/) || [])[1] || baseFrom;
  const fromAddr = job.fromAddr || defaultAddr;
  const from = job.fromName ? `${job.fromName} <${fromAddr}>` : baseFrom;
  const recipients = job.kind === 'pl' ? (job.plEmail ? [job.plEmail] : []) : (audiences[audienceKey(job)] || []);
  if (!recipients.length) return { sent: 0, skipped: 'no recipients' };
  // Flyer goes on as a real attachment (not embedded) -- Resend fetches it itself
  // from our own image-proxy URL, so we don't need to read the bytes ourselves.
  const attachments = job.flyerUrl ? [{ filename: 'flyer.jpg', path: job.flyerUrl }] : undefined;
  let sent = 0;
  if (job.kind === 'pl') {
    const r = await resend.emails.send({ from, to: recipients, bcc: (job.bcc && job.bcc.length) ? job.bcc : undefined, subject: job.subject, text: job.body, html: toHtml(job.body), replyTo: job.replyTo, attachments });
    if (r.error) throw new Error(r.error.message || 'Resend error');
    sent = recipients.length;
  } else {
    const extra = (Array.isArray(job.dirBcc) && job.dirBcc.length)
      ? job.dirBcc
      : (((job.key === 'att3' || job.key === 'att0') && directors[job.eventId]) ? [directors[job.eventId]] : []);
    const groups = chunk(recipients, 45);
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      const bcc = (gi === 0 && extra.length) ? g.concat(extra) : g;
      const r = await resend.emails.send({ from, to: [from], bcc, subject: job.subject, text: job.body, html: toHtml(job.body), replyTo: job.replyTo, attachments });
      if (r.error) throw new Error(r.error.message || 'Resend error');
      sent += g.length;
    }
  }
  return { sent };
}
