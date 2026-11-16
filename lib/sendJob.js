import { Resend } from 'resend';
import crypto from 'crypto';

const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

const RSVP_URL = 'https://forms.cloud.microsoft/Pages/ResponsePage.aspx?id=Mroc1uTzJEKDyxHCW7gZ0jjOWHonDFNFp2Wp8sxbuP5UOFpCRFVCSTlITVE3TlJRUTBXUEI1SzE0US4u';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const rsvpButton = (url) => '<a href="' + url + '" style="display:inline-block;background:#2f9e6f;color:#fff;text-decoration:none;'
  + 'padding:14px 28px;border-radius:10px;font-weight:700;font-size:16px;margin:4px 0">I\'m RSVPing!</a>';
const calButton = (url) => '<a href="' + url + '" style="display:inline-block;background:#2f8fc9;color:#fff;text-decoration:none;'
  + 'padding:12px 24px;border-radius:10px;font-weight:700;font-size:14px;margin:4px 0">📅 Add to Calendar</a>';

// Render a plain-text body as HTML: make URLs clickable, turn an /rsvp.html link
// into a real "I'm RSVPing!" button, show the old Forms RSVP link as bold text,
// and turn newlines into line breaks. Optionally prepends a clickable flyer image
// (HTML-only -- the plain-text version just keeps its normal text links).
function toHtml(body, { flyerUrl, flyerLinkUrl } = {}) {
  let h = esc(body);
  h = h.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#1c6fd6">$1</a>');
  h = h.replace('RSVP here: <a href="' + RSVP_URL + '" style="color:#1c6fd6">' + RSVP_URL + '</a>',
    '<a href="' + RSVP_URL + '" style="color:#1c6fd6;font-weight:700">RSVP here</a>');
  h = h.replace(/<a href="(https?:\/\/[^"]*\/rsvp\.html\?event=[^"]*)" style="color:#1c6fd6">\1<\/a>/g,
    (full, url) => rsvpButton(url));
  h = h.replace(/<a href="(https?:\/\/[^"]*\/api\/ics\?eventId=[^"]*)" style="color:#1c6fd6">\1<\/a>/g,
    (full, url) => calButton(url));
  h = h.replace(/\n/g, '<br>');
  const flyer = flyerUrl
    ? '<a href="' + (flyerLinkUrl || flyerUrl) + '"><img src="' + flyerUrl + '" alt="Event flyer" style="max-width:100%;border-radius:12px;display:block;margin:20px auto 0"></a>'
    : '';
  return '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.6;color:#222">' + h + flyer + '</div>';
}

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
  const recipients = job.kind === 'pl' ? (job.plEmail ? [job.plEmail] : []) : (audiences[job.label] || []);
  if (!recipients.length) return { sent: 0, skipped: 'no recipients' };
  const flyerOpts = { flyerUrl: job.flyerUrl, flyerLinkUrl: job.flyerLinkUrl };
  let sent = 0;
  if (job.kind === 'pl') {
    const r = await resend.emails.send({ from, to: recipients, bcc: (job.bcc && job.bcc.length) ? job.bcc : undefined, subject: job.subject, text: job.body, html: toHtml(job.body, flyerOpts), replyTo: job.replyTo });
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
      const r = await resend.emails.send({ from, to: [from], bcc, subject: job.subject, text: job.body, html: toHtml(job.body, flyerOpts), replyTo: job.replyTo });
      if (r.error) throw new Error(r.error.message || 'Resend error');
      sent += g.length;
    }
  }
  return { sent };
}
