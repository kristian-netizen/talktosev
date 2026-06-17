// Shared helpers used by /api/create-booking.js and /api/stripe-webhook.js.
// CommonJS — pulled in by Vercel function bundling.

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const TZ_OFFSET_HOURS = 8;         // AWST
const SESSION_LEN_MIN = 60;
const ALLOWED_SLOTS   = ['04:30', '05:30', '15:00', '16:00'];

// ---------------------------------------------------------------------------
// AWST <-> UTC
// ---------------------------------------------------------------------------
function awstToUtcMs(yyyyMmDd, hh, mm) {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hh - TZ_OFFSET_HOURS, mm);
}

function awstToUtcIso(yyyyMmDd, hhMmSs) {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const [hh, mm]  = hhMmSs.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh - TZ_OFFSET_HOURS, mm)).toISOString();
}

function addMinutes(yyyyMmDd, hh, mm, plusMin) {
  const total = hh * 60 + mm + plusMin;
  const eh = Math.floor(total / 60);
  const em = total % 60;
  return {
    hh: eh,
    mm: em,
    hhMm: `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}:00`
  };
}

// ---------------------------------------------------------------------------
// Display formatting
// ---------------------------------------------------------------------------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]
  ));
}

function formatAwst(yyyyMmDd, hhMmSs) {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const [hh, mm]  = hhMmSs.split(':').map(Number);
  const dt  = new Date(Date.UTC(y, m - 1, d, 4));
  const dow = new Intl.DateTimeFormat('en-AU', { weekday: 'short', timeZone: 'UTC' }).format(dt);
  const mon = new Intl.DateTimeFormat('en-AU', { month: 'short',  timeZone: 'UTC' }).format(dt);
  const period = hh >= 12 ? 'pm' : 'am';
  const h12 = hh === 0 ? 12 : hh > 12 ? hh - 12 : hh;
  const time = mm === 0 ? `${h12}:00 ${period}` : `${h12}:${String(mm).padStart(2, '0')} ${period}`;
  return { dateLine: `${dow} ${d} ${mon} ${y}`, timeLine: time };
}

// ---------------------------------------------------------------------------
// Google Calendar
// ---------------------------------------------------------------------------
async function getGoogleAccessToken() {
  const params = new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    grant_type:    'refresh_token'
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  const data = await r.json();
  if (!r.ok || !data.access_token) {
    throw new Error('Google token refresh failed: ' + JSON.stringify(data));
  }
  return data.access_token;
}

async function fetchCalendarBusy(token, timeMin, timeMax) {
  const r = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify({
      timeMin,
      timeMax,
      timeZone: 'Australia/Perth',
      items: [{ id: 'primary' }]
    })
  });
  const data = await r.json();
  if (!r.ok) throw new Error('FreeBusy failed: ' + JSON.stringify(data));
  return (data.calendars && data.calendars.primary && data.calendars.primary.busy) || [];
}

async function createCalendarEvent(token, booking, opts = {}) {
  const startUtc = awstToUtcIso(booking.session_date, booking.session_slot);
  const endUtc   = awstToUtcIso(booking.session_date, booking.session_end);

  // Derive the booking type — falls back to inferring from pack_id for older rows.
  const type = booking.session_type || (booking.pack_id ? 'pack' : 'paid_single');

  let summary, headline, payLine;
  if (type === 'free_intro') {
    summary  = `Free intro: Sev × ${booking.client_name}`;
    headline = 'Free 60-minute intro call.';
    payLine  = 'No charge — free intro call.';
  } else if (type === 'free_quick') {
    summary  = `Quick chat: Sev × ${booking.client_name}`;
    headline = 'Free 30-minute quick chat.';
    payLine  = 'No charge — free quick chat.';
  } else if (type === 'pack') {
    summary  = `Run Claude With Me: Sev × ${booking.client_name}`;
    headline = 'Run Claude With Me: 60-minute 1:1 session.';
    payLine  = opts.packLabel || 'Paid via 4-Session Pack';
  } else {
    summary  = `Run Claude With Me: Sev × ${booking.client_name}`;
    headline = 'Run Claude With Me: 60-minute 1:1 session.';
    payLine  = `Paid: $${((booking.amount_paid_cents || 38500) / 100).toFixed(2)} ${(booking.amount_currency || 'AUD').toUpperCase()} (Stripe)`;
  }

  const notesBlock = booking.notes ? `\nWhat they want to chat about:\n${booking.notes}\n` : '';

  const evt = {
    summary,
    description:
      `${headline}\n\n` +
      `Client: ${booking.client_name}\n` +
      `Email: ${booking.client_email}\n` +
      `Mobile: ${booking.client_mobile || '(not provided)'}\n` +
      `${payLine}\n` +
      `${notesBlock}` +
      `Booking ID: ${booking.id}`,
    start:    { dateTime: startUtc, timeZone: 'Australia/Perth' },
    end:      { dateTime: endUtc,   timeZone: 'Australia/Perth' },
    attendees: [
      { email: booking.client_email, displayName: booking.client_name },
      { email: 'sev@sevspics.com', organizer: true, self: true }
    ],
    conferenceData: {
      createRequest: {
        requestId: booking.id,
        conferenceSolutionKey: { type: 'hangoutsMeet' }
      }
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email', minutes: 60 },
        { method: 'popup', minutes: 15 }
      ]
    }
  };

  const url = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'
            + '?conferenceDataVersion=1&sendUpdates=all';
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify(evt)
  });
  const data = await r.json();
  if (!r.ok) throw new Error('Calendar create failed: ' + JSON.stringify(data));
  return data;
}

// ---------------------------------------------------------------------------
// Supabase REST helpers
// ---------------------------------------------------------------------------
function supabaseHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    'apikey':        key,
    'Authorization': 'Bearer ' + key,
    'Content-Type':  'application/json'
  };
}

/**
 * Fetch any booking that "holds" a slot on the given date.
 * Includes: pending bookings with expires_at > now, plus all confirmed bookings.
 * Pack-redeemed bookings are stored as confirmed, so this covers them too.
 */
async function fetchActiveBookingsForDay(dateStr) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const nowIso = new Date().toISOString();
  // PostgREST OR: status=confirmed OR (status=pending AND expires_at>now)
  const orClause = `or=(status.eq.confirmed,and(status.eq.pending,expires_at.gt.${encodeURIComponent(nowIso)}))`;
  const qs = `select=session_slot,session_end,status,expires_at`
           + `&session_date=eq.${dateStr}`
           + `&${orClause}`;
  const r = await fetch(`${supabaseUrl}/rest/v1/bookings?${qs}`, {
    headers: supabaseHeaders()
  });
  if (!r.ok) throw new Error('Active-bookings fetch failed: ' + r.status);
  return r.json();
}

/**
 * Manual availability blocks set by Sev via /admin/availability.
 * Returns busy ranges (UTC ISO) for the given AWST date range, inclusive.
 */
async function fetchBlocksInRange(fromDate, toDate) {
  const url = process.env.SUPABASE_URL;
  const qs = `select=block_date,block_slot,duration_min`
           + `&block_date=gte.${fromDate}`
           + `&block_date=lte.${toDate}`;
  const r = await fetch(`${url}/rest/v1/slot_blocks?${qs}`, { headers: supabaseHeaders() });
  if (!r.ok) throw new Error('Blocks fetch failed: ' + r.status);
  const rows = await r.json();
  return rows.map(b => {
    const [y, m, d] = b.block_date.split('-').map(Number);
    const [hh, mm]  = b.block_slot.split(':').map(Number);
    const dur       = b.duration_min || 60;
    const startMs   = Date.UTC(y, m - 1, d, hh - TZ_OFFSET_HOURS, mm);
    const endMs     = startMs + dur * 60 * 1000;
    return {
      start: new Date(startMs).toISOString(),
      end:   new Date(endMs).toISOString()
    };
  });
}

async function fetchBlocksForDay(dateStr) {
  return fetchBlocksInRange(dateStr, dateStr);
}

function slotConflictsWith(slotStartMs, slotEndMs, busyArr, bufferMs = 0) {
  for (const b of busyArr) {
    const bs = new Date(b.start).getTime() - bufferMs;
    const be = new Date(b.end).getTime()   + bufferMs;
    if (slotStartMs < be && slotEndMs > bs) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Access code generation
// ---------------------------------------------------------------------------
// 12 chars from a 32-char unambiguous alphabet (no 0/O/1/I/l).
// Format: PACK-XXXX-XXXX-XXXX  →  e.g. PACK-X9F2-MNK7-PQRT
// 32^12 ≈ 1.15e18 possibilities — collision and brute-force resistant.
function generateAccessCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = crypto.randomBytes(12);
  let code = 'PACK-';
  for (let i = 0; i < 12; i++) {
    code += chars[buf[i] % chars.length];
    if (i === 3 || i === 7) code += '-';
  }
  return code;
}

function isValidAccessCode(s) {
  return typeof s === 'string'
      && /^PACK-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(s);
}

// ---------------------------------------------------------------------------
// Resend (email) helpers
// ---------------------------------------------------------------------------
async function resendSend({ to, subject, html, text, replyTo }) {
  const key  = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL || 'Sev <sev@talktosev.com>';
  if (!key) { console.warn('RESEND_API_KEY missing — skipping email to', to); return; }
  const body = { from, to: Array.isArray(to) ? to : [to], subject, html, text };
  if (replyTo) body.reply_to = replyTo;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const txt = await r.text();
    console.error('Resend send failed:', r.status, txt);
  }
}

async function sendBookingConfirmationEmails(booking, meetLink, eventHtmlLink) {
  const start = formatAwst(booking.session_date, booking.session_slot);
  const end   = formatAwst(booking.session_date, booking.session_end);
  const safeName = escapeHtml(booking.client_name);
  const safeMeet = meetLink ? escapeHtml(meetLink) : '';
  const isPack   = !!booking.pack_id;

  const paidLineHtml = isPack
    ? `Redeemed via your 4-Session Pack. ${escapeHtml(String(booking.pack_remaining_label || ''))}`.trim()
    : 'Payment received.';
  const paidLineText = isPack
    ? `Redeemed via your 4-Session Pack. ${booking.pack_remaining_label || ''}`.trim()
    : 'Payment received.';

  // ---- Client email ---------------------------------------------------
  const clientHtml = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#0a0a0a;color:#e8e4dc;font-family:-apple-system,'Segoe UI',sans-serif;font-size:16px;line-height:1.55;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0a0a0a;">
    <tr><td align="center" style="padding:40px 20px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#111;border:1px solid #222;border-radius:12px;padding:36px 32px;">
        <tr><td>
          <p style="margin:0 0 8px;font-size:0.78rem;letter-spacing:0.2em;text-transform:uppercase;color:#c8a96e;">Run Claude With Me</p>
          <h1 style="margin:0 0 18px;font-size:26px;line-height:1.15;color:#fff;font-weight:600;">You're booked in, ${safeName}.</h1>
          <p style="margin:0 0 16px;">${paidLineHtml} Your 60-minute session is confirmed for:</p>
          <div style="margin:18px 0;padding:18px;background:#0d0d0d;border:1px solid #222;border-radius:10px;">
            <p style="margin:0 0 6px;color:#fff;font-size:18px;font-weight:600;">${start.dateLine}</p>
            <p style="margin:0;color:#c8a96e;font-size:16px;">${start.timeLine} – ${end.timeLine} AWST</p>
          </div>
          ${meetLink ? `<p style="margin:0 0 16px;">Calendar invite with the Google Meet link is in your inbox separately. Or join directly:</p>
          <p style="margin:0 0 24px;"><a href="${safeMeet}" style="display:inline-block;background:#c8a96e;color:#0a0a0a;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700;">Join Google Meet →</a></p>` : ''}
          <p style="margin:0 0 16px;color:#b8b3a9;">What we'll cover: whatever you're stuck on. Building, debugging, scoping, shipping. Bring your screen, bring your questions.</p>
          <p style="margin:0 0 16px;color:#b8b3a9;">Note: bookings are final. By completing this booking you agreed to our <a href="https://www.talktosev.com/book/terms" style="color:#c8a96e;">Terms &amp; Conditions</a>, which include a no-refund and no-reschedule policy.</p>
          <hr style="border:none;border-top:1px solid #222;margin:28px 0;">
          <p style="margin:0;color:#777;font-size:0.9rem;">Sev<br><a href="https://talktosev.com" style="color:#777;text-decoration:underline;">talktosev.com</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const clientText = `You're booked in, ${booking.client_name}.

${paidLineText} Your 60-minute session is confirmed for:
${start.dateLine}
${start.timeLine} – ${end.timeLine} AWST

${meetLink ? 'Join the Google Meet: ' + meetLink + '\n\n' : ''}What we'll cover: whatever you're stuck on. Bring your screen, bring your questions.

Note: bookings are final. By completing this booking you agreed to our Terms & Conditions (https://www.talktosev.com/book/terms), which include a no-refund and no-reschedule policy.

Sev
https://talktosev.com`;

  await resendSend({
    to:      booking.client_email,
    subject: `Confirmed: Run Claude With Me on ${start.dateLine}`,
    html:    clientHtml,
    text:    clientText,
    replyTo: 'sev@sevspics.com'
  });

  // ---- Sev notification ----------------------------------------------
  const sevPaid = isPack
    ? `Source: ${booking.pack_remaining_label ? '4-Session Pack — ' + booking.pack_remaining_label : '4-Session Pack'}`
    : `Paid:   $${(booking.amount_paid_cents ? (booking.amount_paid_cents / 100).toFixed(2) : '385.00')} ${(booking.amount_currency || 'AUD').toUpperCase()}`;

  const sevText = `New Run Claude With Me booking:

Client: ${booking.client_name}
Email:  ${booking.client_email}
Mobile: ${booking.client_mobile || '(not provided)'}

When:   ${start.dateLine} · ${start.timeLine} – ${end.timeLine} AWST
${sevPaid}

Calendar event: ${eventHtmlLink || '(no link)'}
Meet link:      ${meetLink || '(no link)'}

Booking ID: ${booking.id}`;

  await resendSend({
    to:      'sev@sevspics.com',
    subject: `🟢 Booking: ${booking.client_name} on ${start.dateLine} ${start.timeLine}`,
    text:    sevText
  });
}

// ---------------------------------------------------------------------------
// Pack-ready email (sent after a 4-pack purchase clears Stripe)
// ---------------------------------------------------------------------------
/**
 * Send the pack-ready emails.
 *
 * opts.firstSessionBooked — true when the customer booked the first session at
 *   the time of pack purchase and we successfully reserved that slot. Copy
 *   shifts from "book your first session" → "use this code for sessions 2-4."
 *
 * opts.firstSessionLost — true when the customer tried to book a first session
 *   during pack purchase but the slot was no longer available by webhook time.
 *   Copy apologises and routes them back to the same code-redemption page.
 *
 * opts.firstSessionDateLine / opts.firstSessionTimeLine — only used when
 *   firstSessionBooked is true; let us mention the actual day/time inline.
 */
async function sendPackReadyEmails(pack, opts = {}) {
  const firstSessionBooked = !!opts.firstSessionBooked;
  const firstSessionLost   = !!opts.firstSessionLost;

  const code         = pack.access_code;
  const bookingUrl   = `https://www.talktosev.com/book?code=${encodeURIComponent(code)}`;
  const safeName     = escapeHtml(pack.customer_name);
  const safeCode     = escapeHtml(code);
  const safeUrl      = escapeHtml(bookingUrl);
  const expiresLocal = new Intl.DateTimeFormat('en-AU', {
    day: 'numeric', month: 'long', year: 'numeric'
  }).format(new Date(pack.expires_at));

  // Headline + lead copy varies per mode --------------------------------
  let subject, headline, leadHtml, leadText, ctaHtml, ctaText, codeHelpText;

  if (firstSessionBooked) {
    const dateLine = opts.firstSessionDateLine || '(see calendar invite)';
    const timeLine = opts.firstSessionTimeLine || '';
    const safeDate = escapeHtml(dateLine);
    const safeTime = escapeHtml(timeLine);

    subject  = `Your 4-pack is ready — first session booked`;
    headline = `Pack ready, ${safeName}. First session locked in.`;
    leadHtml = `Payment received. <strong style="color:#0e0d0b;">Your first session is booked for ${safeDate}${safeTime ? ' · ' + safeTime : ''}</strong> — calendar invite with the Google Meet link is on its way in a separate email.`;
    leadText = `Payment received. Your first session is booked for ${dateLine}${timeLine ? ' · ' + timeLine : ''} — calendar invite with the Google Meet link is on its way separately.`;
    ctaHtml  = `<p style="margin:0 0 22px;"><a href="${safeUrl}" style="display:inline-block;background:#e63935;color:#fbf5e7;padding:14px 26px;border:2px solid #0e0d0b;text-decoration:none;font-weight:700;letter-spacing:-0.005em;">Book another session →</a></p>`;
    ctaText  = `Book your remaining sessions whenever you're ready: ${bookingUrl}`;
    codeHelpText = `You have <strong style="color:#0e0d0b;">3 sessions remaining</strong>. Use the link above any time to book them.`;
  } else if (firstSessionLost) {
    subject  = `Your 4-pack is ready — please rebook your first session`;
    headline = `Pack ready, ${safeName}.`;
    leadHtml = `Payment received. Heads up — the slot you picked at checkout was taken just before we could lock it in, so <strong style="color:#0e0d0b;">your first session isn't booked yet</strong>. Apologies for the bump.`;
    leadText = `Payment received. Heads up — the slot you picked at checkout was taken just before we could lock it in, so your first session isn't booked yet. Apologies for the bump.`;
    ctaHtml  = `<p style="margin:0 0 22px;"><a href="${safeUrl}" style="display:inline-block;background:#e63935;color:#fbf5e7;padding:14px 26px;border:2px solid #0e0d0b;text-decoration:none;font-weight:700;letter-spacing:-0.005em;">Pick a new time →</a></p>`;
    ctaText  = `Pick a new time for your first session: ${bookingUrl}`;
    codeHelpText = `You have <strong style="color:#0e0d0b;">all 4 sessions</strong> available. The link above works for every booking.`;
  } else {
    subject  = `Your Run Claude With Me 4-pack is ready`;
    headline = `Your pack is ready, ${safeName}.`;
    leadHtml = `Payment received. You've got <strong style="color:#0e0d0b;">${pack.total_sessions} sessions</strong> on the clock, valid until <strong style="color:#0e0d0b;">${expiresLocal}</strong>.`;
    leadText = `Payment received. You've got ${pack.total_sessions} sessions on the clock, valid until ${expiresLocal}.`;
    ctaHtml  = `<p style="margin:0 0 22px;"><a href="${safeUrl}" style="display:inline-block;background:#e63935;color:#fbf5e7;padding:14px 26px;border:2px solid #0e0d0b;text-decoration:none;font-weight:700;letter-spacing:-0.005em;">Book your first session →</a></p>`;
    ctaText  = `Book your first session: ${bookingUrl}`;
    codeHelpText = `The same link works for every session in your pack. After your 4th booking it'll just stop accepting new sessions.`;
  }

  // Client email --------------------------------------------------------
  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f4ecdc;color:#0e0d0b;font-family:-apple-system,'Segoe UI',sans-serif;font-size:16px;line-height:1.55;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4ecdc;">
    <tr><td align="center" style="padding:40px 20px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#fbf5e7;border:2px solid #0e0d0b;padding:36px 32px;">
        <tr><td>
          <p style="margin:0 0 10px;font-size:0.78rem;letter-spacing:0.18em;text-transform:uppercase;color:#e63935;font-weight:600;">Run Claude With Me — 4-Session Pack</p>
          <h1 style="margin:0 0 18px;font-size:28px;line-height:1.05;color:#0e0d0b;font-weight:800;letter-spacing:-0.03em;">${headline}</h1>
          <p style="margin:0 0 18px;color:#0e0d0b;">${leadHtml}</p>
          <div style="margin:22px 0;padding:18px;background:#f4ecdc;border:2px solid #0e0d0b;">
            <p style="margin:0 0 8px;color:#4f4940;font-size:0.78rem;letter-spacing:0.18em;text-transform:uppercase;font-weight:600;">Your access code</p>
            <p style="margin:0 0 14px;font-family:Menlo,Consolas,monospace;font-size:20px;color:#0e0d0b;letter-spacing:0.05em;font-weight:700;">${safeCode}</p>
            <p style="margin:0;color:#4f4940;font-size:14px;">${codeHelpText}</p>
          </div>
          ${ctaHtml}
          <p style="margin:0 0 14px;color:#4f4940;">Valid until <strong style="color:#0e0d0b;">${expiresLocal}</strong>. After that, unused sessions expire.</p>
          <p style="margin:0 0 16px;color:#4f4940;">Note: pack purchases are final and individual bookings cannot be rescheduled. Full terms: <a href="https://www.talktosev.com/book/terms" style="color:#e63935;">talktosev.com/book/terms</a>.</p>
          <hr style="border:none;border-top:2px solid #0e0d0b;margin:28px 0;">
          <p style="margin:0;color:#4f4940;font-size:0.9rem;">Sev<br><a href="https://talktosev.com" style="color:#4f4940;text-decoration:underline;">talktosev.com</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = `${headline.replace(/<[^>]+>/g, '')}

${leadText}

Your access code: ${code}
${codeHelpText.replace(/<[^>]+>/g, '')}

${ctaText}

Valid until ${expiresLocal}. After that, unused sessions expire.

Note: pack purchases are final and individual bookings cannot be rescheduled.
Full terms: https://www.talktosev.com/book/terms

Sev
https://talktosev.com`;

  await resendSend({
    to:      pack.customer_email,
    subject,
    html,
    text,
    replyTo: 'sev@sevspics.com'
  });

  // Sev notification ----------------------------------------------------
  const bookingStatusLine =
    firstSessionBooked ? `First session: BOOKED (${opts.firstSessionDateLine || '?'}${opts.firstSessionTimeLine ? ' · ' + opts.firstSessionTimeLine : ''})` :
    firstSessionLost   ? `First session: SLOT LOST — customer needs to rebook via access code` :
                         `First session: not booked at purchase (legacy flow / direct Stripe link)`;

  const sevText = `New 4-Session Pack purchase:

Client: ${pack.customer_name}
Email:  ${pack.customer_email}
Mobile: ${pack.customer_mobile || '(not provided)'}

${bookingStatusLine}

Access code: ${pack.access_code}
Expires: ${expiresLocal}
Source: ${pack.source}
Amount: ${pack.amount_paid_cents ? '$' + (pack.amount_paid_cents / 100).toFixed(2) + ' ' + (pack.amount_currency || 'AUD').toUpperCase() : '(no amount recorded)'}

Pack ID: ${pack.id}`;

  const sevSubject = firstSessionLost
    ? `⚠️ 4-pack purchased but first-session slot lost: ${pack.customer_name}`
    : firstSessionBooked
      ? `📦 New 4-pack + first session: ${pack.customer_name}`
      : `📦 New 4-pack: ${pack.customer_name}`;

  await resendSend({
    to:      'sev@sevspics.com',
    subject: sevSubject,
    text:    sevText
  });
}

// ---------------------------------------------------------------------------
// Free booking confirmation emails (sent after a /chat free booking is taken)
// ---------------------------------------------------------------------------
async function sendFreeBookingConfirmationEmails(booking, meetLink, eventHtmlLink) {
  const start    = formatAwst(booking.session_date, booking.session_slot);
  const end      = formatAwst(booking.session_date, booking.session_end);
  const isIntro  = booking.session_type === 'free_intro';
  const safeName = escapeHtml(booking.client_name);
  const safeMeet = meetLink ? escapeHtml(meetLink) : '';
  const safeNotes = booking.notes ? escapeHtml(booking.notes) : '';

  const labelLong   = isIntro ? '60-minute intro call' : '30-minute quick chat';
  const labelShort  = isIntro ? 'intro call'           : 'quick chat';
  const eyebrowText = isIntro ? 'Free intro call'      : 'Free quick chat';

  // ---- Client email -------------------------------------------------------
  const clientHtml = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f4ecdc;color:#0e0d0b;font-family:-apple-system,'Segoe UI',sans-serif;font-size:16px;line-height:1.55;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4ecdc;">
    <tr><td align="center" style="padding:40px 20px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#fbf5e7;border:2px solid #0e0d0b;padding:36px 32px;">
        <tr><td>
          <p style="margin:0 0 10px;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#e63935;font-weight:600;">${eyebrowText}</p>
          <h1 style="margin:0 0 18px;font-size:28px;line-height:1.05;color:#0e0d0b;font-weight:800;letter-spacing:-0.02em;">Locked in, ${safeName}.</h1>
          <p style="margin:0 0 16px;color:#4f4940;">Your ${labelLong} with Sev is confirmed for:</p>
          <div style="margin:18px 0;padding:18px;background:#ffcb3c;border:2px solid #0e0d0b;">
            <p style="margin:0 0 4px;color:#0e0d0b;font-size:18px;font-weight:800;letter-spacing:-0.01em;">${start.dateLine}</p>
            <p style="margin:0;color:#0e0d0b;font-size:15px;">${start.timeLine} – ${end.timeLine} AWST</p>
          </div>
          ${meetLink ? `<p style="margin:0 0 16px;color:#4f4940;">Calendar invite with the Google Meet link is on its way separately. Or join directly:</p>
          <p style="margin:0 0 22px;"><a href="${safeMeet}" style="display:inline-block;background:#e63935;color:#fbf5e7;padding:13px 24px;border:2px solid #0e0d0b;text-decoration:none;font-weight:700;letter-spacing:-0.005em;">Join Google Meet →</a></p>` : ''}
          ${safeNotes ? `<p style="margin:0 0 8px;color:#4f4940;"><strong style="color:#0e0d0b;">What you said you'd like to chat about:</strong></p>
          <p style="margin:0 0 16px;padding:14px;background:#f4ecdc;border:1px solid #0e0d0b;color:#0e0d0b;white-space:pre-wrap;">${safeNotes}</p>` : ''}
          <p style="margin:0 0 16px;color:#4f4940;">If you need to reschedule or cancel, just reply to this email — at least 24 hours before would be amazing.</p>
          <hr style="border:none;border-top:1px solid #0e0d0b;margin:28px 0;">
          <p style="margin:0;color:#4f4940;font-size:13px;">Sev<br><a href="https://talktosev.com" style="color:#e63935;text-decoration:underline;">talktosev.com</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const clientText = `Locked in, ${booking.client_name}.

Your ${labelLong} with Sev is confirmed for:
${start.dateLine}
${start.timeLine} – ${end.timeLine} AWST

${meetLink ? 'Join the Google Meet: ' + meetLink + '\n\n' : ''}${booking.notes ? "What you said you'd like to chat about:\n" + booking.notes + '\n\n' : ''}If you need to reschedule or cancel, just reply to this email — at least 24 hours before would be amazing.

Sev
https://talktosev.com`;

  await resendSend({
    to:      booking.client_email,
    subject: `Confirmed: ${isIntro ? 'Intro call' : 'Quick chat'} with Sev on ${start.dateLine}`,
    html:    clientHtml,
    text:    clientText,
    replyTo: 'sev@sevspics.com'
  });

  // ---- Sev notification ---------------------------------------------------
  const sevText = `New free ${labelShort} booking:

Client: ${booking.client_name}
Email:  ${booking.client_email}
Mobile: ${booking.client_mobile || '(not provided)'}

When:   ${start.dateLine} · ${start.timeLine} – ${end.timeLine} AWST
Type:   ${isIntro ? 'Free 60-min intro call' : 'Free 30-min quick chat'}

${booking.notes ? "What they want to chat about:\n" + booking.notes + '\n' : '(no notes provided)\n'}
Calendar event: ${eventHtmlLink || '(no link)'}
Meet link:      ${meetLink || '(no link)'}

Booking ID: ${booking.id}`;

  await resendSend({
    to:      'sev@sevspics.com',
    subject: `${isIntro ? '🎙️' : '☕'} Free ${labelShort}: ${booking.client_name} on ${start.dateLine} ${start.timeLine}`,
    text:    sevText
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  // constants
  TZ_OFFSET_HOURS,
  SESSION_LEN_MIN,
  ALLOWED_SLOTS,
  // time
  awstToUtcMs,
  awstToUtcIso,
  addMinutes,
  formatAwst,
  // text
  escapeHtml,
  // google
  getGoogleAccessToken,
  fetchCalendarBusy,
  createCalendarEvent,
  // supabase
  supabaseHeaders,
  fetchActiveBookingsForDay,
  fetchBlocksForDay,
  fetchBlocksInRange,
  slotConflictsWith,
  // codes
  generateAccessCode,
  isValidAccessCode,
  // email
  resendSend,
  sendBookingConfirmationEmails,
  sendPackReadyEmails,
  sendFreeBookingConfirmationEmails
};
