import { Resend } from 'resend';
import crypto from 'crypto';
import { readJSON } from './blobstore.js';

const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

const RSVP_URL = 'https://forms.cloud.microsoft/Pages/ResponsePage.aspx?id=Mroc1uTzJEKDyxHCW7gZ0jjOWHonDFNFp2Wp8sxbuP5UOFpCRFVCSTlITVE3TlJRUTBXUEI1SzE0US4u';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const rsvpButton = (url) => '<a href="' + url + '" style="display:inline-block;background:#2f9e6f;color:#fff;text-decoration:none;'
  + 'padding:14px 28px;border-radius:10px;font-weight:700;font-size:16px;margin:4px 0">I\'m RSVPing!</a>';
const calButton = (url) => '<a href="' + url + '" style="display:inline-block;background:#2f8fc9;color:#fff;text-decoration:none;'
  + 'padding:12px 24px;border-radius:10px;font-weight:700;font-size:14px;margin:4px 0">'
  + (/\/calendar\.html/.test(url) ? '📅 Add to Calendar'
    : /[?&](amp;)?google=1/.test(url) ? '📅 Add to Google Calendar'
    : /[?&](amp;)?outlook=1/.test(url) ? '📅 Add to Outlook Calendar'
    : '📅 Add to Apple Calendar') + '</a>';

// Render a plain-text body as HTML: make URLs clickable, turn an /rsvp.html link
// into a real "I'm RSVPing!" button, show the old Forms RSVP link as bold text,
// and turn newlines into line breaks. The flyer (if any) goes on as a real
// attachment instead -- see sendJob() -- not embedded inline here.
export function toHtml(body) {
  let h = esc(body);
  h = h.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#1c6fd6">$1</a>');
  h = h.replace('RSVP here: <a href="' + RSVP_URL + '" style="color:#1c6fd6">' + RSVP_URL + '</a>',
    '<a href="' + RSVP_URL + '" style="color:#1c6fd6;font-weight:700">RSVP here</a>');
  h = h.replace(/<a href="(https?:\/\/[^"]*\/rsvp\.html\?event=[^"]*)" style="color:#1c6fd6">\1<\/a>/g,
    (full, url) => rsvpButton(url));
  h = h.replace(/<a href="(https?:\/\/[^"]*\/api\/ics\?eventId=[^"]*)" style="color:#1c6fd6">\1<\/a>/g,
    (full, url) => calButton(url));
  // The single "Add to Calendar" link opens a page where the person picks Google, Outlook or Apple.
  h = h.replace(/<a href="(https?:\/\/[^"]*\/calendar\.html\?event=[^"]*)" style="color:#1c6fd6">\1<\/a>/g,
    (full, url) => calButton(url));
  h = h.replace(/\n/g, '<br>');
  return '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.6;color:#222">' + h + '</div>';
}

// Which stored invite list a job sends to. Winter events (ids start "w-") keep
// their rosters under "Winter <label>" -- that's what the winter dashboard's
// Upload button saves -- while summer events use the bare label. Without this,
// a winter job would silently send to the old summer list for the same city.
export const audienceKey = (job) => (job.eventId && String(job.eventId).startsWith('w-') ? 'Winter ' + job.label : job.label);

// For a "nudge" job (job.onlyNonResponders): drop everyone who has already answered that
// party's RSVP, yes or "can't make it". Matched on email, case-insensitively, against
// rsvps.json (eventId -> { email -> answer }). Anyone who RSVP'd with a different address
// than the one on the invite list can't be matched and will still get the nudge.
export const pendingOnly = (job, list, rsvps) => {
  if (!job.onlyNonResponders) return list;
  const answered = new Set(Object.keys((rsvps || {})[job.eventId] || {}).map((e) => e.toLowerCase()));
  return list.filter((e) => !answered.has(String(e).toLowerCase()));
};

// Unguessable approval token for a job id (HMAC with CRON_SECRET).
export function tokenFor(id) {
  return crypto.createHmac('sha256', process.env.CRON_SECRET || 'x').update(String(id)).digest('hex').slice(0, 32);
}

// Every email, regardless of job/kind, shows this as the sender name -- never a
// bare address. A job may still set job.fromAddr to change which mailbox under
// the verified domain it sends from, but the display name is always this one.
const DEFAULT_FROM_NAME = 'Above and Beyond ABA';

// Send one approved job to its real recipients. Attendee -> BCC chunks (director
// BCC'd once on att3/att0). PL -> to the PL, BCC the state director.
export async function sendJob(job, { directors, audiences }) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const baseFrom = process.env.RESEND_FROM;
  // Optional per-job address (e.g. a state director's own address under the
  // verified sending domain) -- distinct addresses per sender avoid mail
  // clients collapsing/mislabeling same-address senders with different
  // display names (seen with Outlook when 3 directors shared one address).
  // The domain itself stays the verified one; only the local part changes,
  // so deliverability/authentication is unaffected.
  const defaultAddr = (baseFrom.match(/<([^>]+)>/) || [])[1] || baseFrom;
  const fromAddr = job.fromAddr || defaultAddr;
  const from = `${job.fromName || DEFAULT_FROM_NAME} <${fromAddr}>`;
  const rsvps = job.onlyNonResponders ? await readJSON('rsvps.json', {}) : null;
  const recipients = job.kind === 'pl' ? (job.plEmail ? [job.plEmail] : []) : pendingOnly(job, audiences[audienceKey(job)] || [], rsvps);
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

// Who approves by replying/clicking the preview, and where a winter job's "fix it"
// link goes -- kept in sync with api/inbound.js's approverFor() and api/cron.js's
// digestFor(). A job id is "<eventId>:<key>"; winter event ids start "w-".
const escH = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const isWinterId = (id) => String(id).startsWith('w-');

// Build and send one job's day-before approval preview, right now (not waiting for
// the next daily cron run). Used both by api/cron.js's daily sweep and by
// api/schedule.js's editAndRepreview action, so a corrected email gets a fresh
// preview immediately instead of sitting until the next day's cron.
export async function sendPreviewEmail(job, id, { audiences, rsvps, origin }) {
  const apiKey = process.env.RESEND_API_KEY, rawFrom = process.env.RESEND_FROM;
  if (!apiKey || !rawFrom) throw new Error('Resend not configured.');
  const fromAddr = (rawFrom.match(/<([^>]+)>/) || [])[1] || rawFrom;
  const from = `Above and Beyond ABA <${fromAddr}>`;
  const replyDomain = fromAddr.split('@')[1] || 'updates.abtaba.com';
  const resend = new Resend(apiKey);

  const count = job.kind === 'pl' ? 1 : pendingOnly(job, audiences[audienceKey(job)] || [], rsvps).length;
  const who = job.kind === 'pl' ? (job.plEmail || '(no PL email)') : (count + ' attendees' + (job.onlyNonResponders ? " who haven't responded yet" : '') + ' (' + job.label + ')');
  const token = tokenFor(id);
  const link = origin + '/api/approve-send?id=' + encodeURIComponent(id) + '&t=' + token;
  const replyTo = `approve.${id.replace(':', '.')}.${token}@${replyDomain}`;
  const winter = isWinterId(id);
  // The dedicated dummy test location is the owner's own sandbox -- its previews
  // always come to her, never to Andrew, regardless of the "w-" winter routing rule.
  const digestTo = (winter && job.eventId !== 'w-test') ? 'amarkovich@abtaba.com' : 'lringle@abtaba.com';
  // Every approval email gets a "needs edit" button, not just winter jobs.
  const fixLink = origin + '/admin.html?open=' + encodeURIComponent(job.eventId) + '&key=' + encodeURIComponent(job.key);

  const r = await resend.emails.send({
    from, to: [digestTo], replyTo,
    subject: `Approve to send — ${job.subject}  (sends ${job.sendOn})`,
    text: `This reminder is scheduled to send on ${job.sendOn} to ${who}.\n\n`
      + `----- EMAIL PREVIEW -----\nSubject: ${job.subject}\n\n${job.body}\n----- END PREVIEW -----\n\n`
      + `APPROVED -- send it: tap this link (or reply "Approved")\n${link}\n\n`
      + (fixLink ? `NOT APPROVED -- need to edit: tap this link to fix it in Admin\n${fixLink}\n\n` : '')
      + `If you do nothing, it will NOT send.`,
    html: `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:580px;color:#1c458c">`
      + `<p style="font-size:15px;color:#333">This reminder is scheduled to send on <b>${escH(job.sendOn)}</b> to <b>${escH(who)}</b>. Review the preview below, then choose one.</p>`
      + `<p style="font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#5f6b7a;font-weight:700;margin-top:22px">Preview</p>`
      + `<p style="font-size:14px;color:#333"><b>Subject:</b> ${escH(job.subject)}</p>`
      + `<div style="background:#f5f0e5;padding:14px;border-radius:10px">${toHtml(job.body)}</div>`
      + `<hr style="border:none;border-top:1px solid #e3d6bd;margin:22px 0">`
      + `<table style="width:100%"><tr>`
      + `<td style="padding-right:8px"><a href="${link}" style="display:block;text-align:center;background:#2f9e6f;color:#fff;text-decoration:none;padding:14px 10px;border-radius:10px;font-weight:700;font-size:15px">✅ Approved — send it</a></td>`
      + (fixLink ? `<td style="padding-left:8px"><a href="${fixLink}" style="display:block;text-align:center;background:#fff;color:#1c458c;text-decoration:none;padding:14px 10px;border-radius:10px;font-weight:700;font-size:15px;border:1px solid #c98a1a">✏️ Not approved — need to edit</a></td>` : '')
      + `</tr></table>`
      + `<p style="color:#888;font-size:13px;margin-top:14px">You can also just reply to this email with the word "Approved". If you do nothing, it will <b>not</b> be sent.</p></div>`,
  });
  if (r.error) throw new Error(r.error.message || 'Resend error');
}
