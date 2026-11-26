import { Resend } from 'resend';

/**
 * POST /api/send  — send one reminder email via Resend.
 *
 * Protected by a shared passcode so the public page can't be used to spam.
 * Required Vercel environment variables:
 *   RESEND_API_KEY  — from resend.com (API Keys)
 *   RESEND_FROM     — a verified sender on abtaba.com, e.g. "Above & Beyond ABA <events@abtaba.com>"
 *   SEND_PASSCODE   — any secret string; the dashboard prompts for it once
 *
 * Body: { subject, text, to?: string[], bcc?: string[], replyTo?: string }
 *  - PL email:        pass `to` (single address)
 *  - Attendee blast:  pass `bcc` (the list); we send in chunks with `to` = the from address
 */
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const cleanList = (v) => Array.isArray(v)
  ? [...new Set(v.map((x) => String(x || '').trim()).filter((x) => x.includes('@')))]
  : [];

// Every email sent through this endpoint shows this as the sender name -- never
// a bare address, regardless of what RESEND_FROM is set to in Vercel.
const FROM_NAME = 'Above and Beyond ABA';

export default async function handler(req, res) {
  const apiKey = process.env.RESEND_API_KEY;
  const rawFrom = process.env.RESEND_FROM;
  const passcode = process.env.SEND_PASSCODE;
  if (!apiKey || !rawFrom) return res.status(501).json({ error: 'Not configured: set RESEND_API_KEY and RESEND_FROM in Vercel.' });
  const fromAddr = (rawFrom.match(/<([^>]+)>/) || [])[1] || rawFrom;
  const from = `${FROM_NAME} <${fromAddr}>`;
  if (!passcode) return res.status(501).json({ error: 'Not configured: set SEND_PASSCODE in Vercel.' });

  const provided = req.headers['x-send-passcode'] || '';
  if (provided !== passcode) return res.status(401).json({ error: 'Incorrect passcode.' });

  // GET ?emailId=<id> -> fetch one sent email's full record from Resend,
  // including the actual HTML that went out (diagnostic).
  if (req.method === 'GET' && req.query && req.query.emailId) {
    try {
      const r = await fetch('https://api.resend.com/emails/' + encodeURIComponent(req.query.emailId), { headers: { Authorization: 'Bearer ' + apiKey } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(502).json({ ok: false, error: j.message || r.status });
      const hasImgTag = typeof j.html === 'string' && j.html.includes('<img');
      return res.status(200).json({ ok: true, hasImgTag, html: j.html, text: j.text, subject: j.subject, last_event: j.last_event });
    } catch (err) {
      return res.status(502).json({ ok: false, error: (err && err.message) || 'Could not reach Resend.' });
    }
  }

  // GET ?recent=1 -> list the last few sent emails from Resend (diagnostic: what
  // "from" header actually went out, vs. what the mail client displayed).
  if (req.method === 'GET' && req.query && 'recent' in req.query) {
    try {
      const r = await fetch('https://api.resend.com/emails', { headers: { Authorization: 'Bearer ' + apiKey } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(502).json({ ok: false, error: j.message || r.status });
      const list = (j.data || []).slice(0, 10).map((e) => ({ id: e.id, from: e.from, to: e.to, subject: e.subject, created_at: e.created_at, last_event: e.last_event }));
      return res.status(200).json({ ok: true, recent: list });
    } catch (err) {
      return res.status(502).json({ ok: false, error: (err && err.message) || 'Could not reach Resend.' });
    }
  }

  // GET ?domainDetail=1 -> the exact DNS records Resend wants for the sending
  // domain and which ones are currently failing (diagnostic).
  if (req.method === 'GET' && req.query && 'domainDetail' in req.query) {
    try {
      const listR = await fetch('https://api.resend.com/domains', { headers: { Authorization: 'Bearer ' + apiKey } });
      const listJ = await listR.json().catch(() => ({}));
      const fromDomain = (from.match(/@([^\s>]+)/) || [])[1] || '';
      const match = (listJ.data || []).find((d) => d.name === fromDomain);
      if (!match) return res.status(404).json({ ok: false, error: 'Domain not found in Resend: ' + fromDomain });
      const detailR = await fetch('https://api.resend.com/domains/' + match.id, { headers: { Authorization: 'Bearer ' + apiKey } });
      const detailJ = await detailR.json().catch(() => ({}));
      return res.status(200).json({ ok: true, domain: detailJ.name, status: detailJ.status, records: detailJ.records });
    } catch (err) {
      return res.status(502).json({ ok: false, error: (err && err.message) || 'Could not reach Resend.' });
    }
  }

  // GET -> read-only Resend health check (API key validity, domain verification,
  // sender-domain match). No email is sent. Passcode-gated like everything else.
  if (req.method === 'GET') {
    try {
      const r = await fetch('https://api.resend.com/domains', { headers: { Authorization: 'Bearer ' + apiKey } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(502).json({ ok: false, error: 'Resend API rejected the key: ' + (j.message || r.status) });
      const fromDomain = (from.match(/@([^\s>]+)/) || [])[1] || '';
      const domains = (j.data || []).map((d) => ({ name: d.name, status: d.status, region: d.region }));
      const fromDomainStatus = domains.find((d) => d.name === fromDomain) || null;
      return res.status(200).json({
        ok: true,
        apiKeyValid: true,
        from,
        fromDomain,
        fromDomainVerified: fromDomainStatus ? fromDomainStatus.status === 'verified' : null,
        domains,
      });
    } catch (err) {
      return res.status(502).json({ ok: false, error: (err && err.message) || 'Could not reach Resend.' });
    }
  }

  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'Method not allowed.' }); }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON body.' }); } }
  const subject = body && body.subject, text = body && body.text;
  const html = (body && body.html) || undefined;
  const to = cleanList(body && body.to), bcc = cleanList(body && body.bcc);
  const replyTo = (body && body.replyTo) || undefined;
  // Resend fetches the file itself from the given URL -- same {filename, path} shape
  // lib/sendJob.js already uses for the real send, so a sample matches it exactly.
  const attachments = (body && Array.isArray(body.attachments) && body.attachments.length) ? body.attachments : undefined;
  if (!subject || !text) return res.status(400).json({ error: 'Missing subject or body.' });
  if (!to.length && !bcc.length) return res.status(400).json({ error: 'No recipients.' });

  const resend = new Resend(apiKey);
  try {
    let sent = 0;
    if (bcc.length) {
      // Bulk: one message per chunk, recipients hidden in BCC, `to` = the from address.
      for (const group of chunk(bcc, 45)) {
        const r = await resend.emails.send({ from, to: [from], bcc: group, subject, text, html, replyTo, attachments });
        if (r.error) throw new Error(r.error.message || 'Resend error');
        sent += group.length;
      }
    } else {
      const r = await resend.emails.send({ from, to, subject, text, html, replyTo, attachments });
      if (r.error) throw new Error(r.error.message || 'Resend error');
      sent += to.length;
    }
    return res.status(200).json({ ok: true, sent });
  } catch (err) {
    return res.status(502).json({ error: (err && err.message) || 'Send failed.' });
  }
}
