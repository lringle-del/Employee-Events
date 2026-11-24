import { readJSON, writeJSON } from '../lib/blobstore.js';
import { sendJob, tokenFor } from '../lib/sendJob.js';
import { Resend } from 'resend';

const SKEY = 'schedule.json', AKEY = 'audiences.json', DKEY = 'directors.json';
// Who's allowed to approve by replying -- matches cron.js's digestFor(): each
// job's preview email goes to one of these two people, and only that same
// person's reply can approve it. A winter job (id starts "w-") belongs to
// Andrew; everything else belongs to Liba.
const SUMMER_APPROVER = 'lringle@abtaba.com';
const WINTER_APPROVER = 'amarkovich@abtaba.com';
const approverFor = (eventId) => (eventId && eventId.startsWith('w-') ? WINTER_APPROVER : SUMMER_APPROVER);
const FORWARD_TO = 'events@abtaba.com';
const OWNER_EMAIL = 'lringle@abtaba.com';

async function forwardReplyTo(to, subjectLine, text, replyTo){
  try{
    const rawFrom = process.env.RESEND_FROM;
    const sendFrom = `Above and Beyond ABA <${(rawFrom.match(/<([^>]+)>/) || [])[1] || rawFrom}>`;
    await new Resend(process.env.RESEND_API_KEY).emails.send({
      from: sendFrom, to: [to], replyTo: replyTo || undefined,
      subject: subjectLine, text,
    });
  }catch{ /* best effort */ }
}

/**
 * Resend inbound webhook (email.received). The preview email's Reply-To is a
 * per-reminder address: approve.<eventId>.<key>.<token>@updates.abtaba.com.
 * When the preview's recipient replies, Resend posts here; we parse the
 * address, verify the token (HMAC of the job id, so it can't be forged) and
 * that it came from that job's approver, then approve + send that reminder.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed.' }); }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(200).json({ ignored: 'bad json' }); } }
  const data = (body && body.data) || body || {};

  const toList = []
    .concat(data.to || [], data.recipient || [], data.to_addresses || [])
    .map((x) => (typeof x === 'string' ? x : (x && x.email) || ''))
    .filter(Boolean);
  const fromRaw = typeof data.from === 'string' ? data.from : ((data.from && data.from.email) || data.sender || '');

  const addr = toList.map((a) => a.toLowerCase()).find((a) => a.startsWith('approve.') && a.includes('@'));
  if (!addr) {
    // Not an approval reply — a message landed on updates.abtaba.com. Forward it to a human so nothing is lost.
    const subj = data.subject || '(no subject)';
    const text = data.text || data.body || data['stripped-text'] || '(The message body is stored in Resend → Inbound for 30 days.)';
    await forwardReplyTo(FORWARD_TO, 'Fwd (reply): ' + subj, `A reply came in to: ${toList.join(', ')}\nFrom: ${fromRaw}\n\n${text}`, fromRaw);
    return res.status(200).json({ forwarded: true });
  }

  const parts = addr.split('@')[0].split('.'); // approve.<eventId>.<key>.<token>
  if (parts.length < 4 || parts[0] !== 'approve') return res.status(200).json({ ignored: 'bad address' });
  const token = parts[parts.length - 1];
  const key = parts[parts.length - 2];
  const eventId = parts.slice(1, parts.length - 2).join('.');
  const id = eventId + ':' + key;

  if (token !== tokenFor(id)) return res.status(200).json({ ignored: 'bad token' });
  if (fromRaw && !fromRaw.toLowerCase().includes(approverFor(eventId))) return res.status(200).json({ ignored: 'not from approver' });

  const all = await readJSON(SKEY, {});
  const job = all[id];
  if (!job) return res.status(200).json({ ignored: 'no such job' });
  if (job.sentAt) return res.status(200).json({ ok: true, note: 'already sent' });

  // Require the actual word "approved" in the reply -- a stray "ok" or "thanks" (or
  // any other reply to that thread) must never trigger a real send. Anything else is
  // treated as a flagged problem and forwarded to the owner instead of being silently
  // dropped, so a reported mistake actually gets seen and the job stays unsent.
  const replyRaw = data.text || data.body || data['stripped-text'] || '';
  if (!replyRaw.toLowerCase().includes('approved')) {
    await forwardReplyTo(
      OWNER_EMAIL,
      `⚠ Needs a fix, not approved: ${job.subject} (${id})`,
      `${fromRaw} replied about "${job.subject}" (scheduled to send ${job.sendOn}) without saying "Approved" -- treating this as a reported problem. Nothing was sent.\n\nTheir reply:\n${replyRaw}\n\nFix it on the Admin page, then approve it again from there.`,
      fromRaw
    );
    return res.status(200).json({ ignored: 'reply did not say approved', forwarded: true });
  }

  job.okToSend = true; // schedule it; the daily job sends on its date
  const today = new Date().toISOString().slice(0, 10);
  let note = 'scheduled for ' + job.sendOn;
  if (job.sendOn <= today) {
    try {
      const auds = await readJSON(AKEY, {}), dirs = await readJSON(DKEY, {});
      const r = await sendJob(job, { directors: dirs, audiences: auds });
      job.sentAt = new Date().toISOString(); job.sentCount = r.sent; note = 'sent now to ' + r.sent + ' recipient(s)';
    } catch (e) { note = 'send failed: ' + e.message; }
  }
  all[id] = job; await writeJSON(SKEY, all);
  return res.status(200).json({ ok: true, id, note });
}
