// Vercel Function: POST /api/create-booking
//
// Two paths:
//
//   1) Single session (no pack_code)
//      → write a pending booking row with 15-min expires_at
//      → return Stripe Payment Link URL with client_reference_id
//      → the webhook later marks confirmed + creates calendar + emails.
//
//   2) Pack redemption (pack_code is a valid PACK-XXXX-XXXX-XXXX code)
//      → validate the pack (active, not expired, sessions remaining)
//      → atomically decrement sessions_used (optimistic concurrency)
//      → write a CONFIRMED booking row with pack_id (no Stripe step)
//      → create the calendar event + send emails synchronously
//      → return a redirect to /book/confirmed?via=pack
//
// Required env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   STRIPE_PAYMENT_LINK
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
//   RESEND_API_KEY, RESEND_FROM_EMAIL

const {
  SESSION_LEN_MIN,
  ALLOWED_SLOTS,
  awstToUtcMs,
  addMinutes,
  getGoogleAccessToken,
  fetchCalendarBusy,
  createCalendarEvent,
  supabaseHeaders,
  fetchActiveBookingsForDay,
  fetchBlocksForDay,
  slotConflictsWith,
  isValidAccessCode,
  sendBookingConfirmationEmails
} = require('../lib/booking-helpers');

const BUFFER_MIN              = 0;
const HOLD_MIN                = 15;
const PACK_REDEEM_REDIRECT    = 'https://www.talktosev.com/book/confirmed?via=pack';
const PACK_LINK_FALLBACK      = 'https://buy.stripe.com/5kQaEXftA2Haejm05q6oo05';

// ---------------------------------------------------------------------------
// Tiny validators
// ---------------------------------------------------------------------------
function bad(res, code, msg) {
  res.status(code).json({ ok: false, error: msg });
}

function clean(value, max = 200) {
  if (value == null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

function validateEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
function validateAuMobile(s) {
  if (typeof s !== 'string') return false;
  const compact = s.replace(/\s+/g, '');
  return /^04\d{8}$/.test(compact) || /^\+614\d{8}$/.test(compact);
}
function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
function isValidSlot(s) {
  return typeof s === 'string' && ALLOWED_SLOTS.includes(s);
}

// ---------------------------------------------------------------------------
// Supabase: bookings + session_packs
// ---------------------------------------------------------------------------
async function insertBooking(row) {
  const url = process.env.SUPABASE_URL;
  const r = await fetch(`${url}/rest/v1/bookings`, {
    method: 'POST',
    headers: { ...supabaseHeaders(), 'Prefer': 'return=representation' },
    body: JSON.stringify(row)
  });
  const txt = await r.text();
  if (!r.ok) throw new Error('Insert booking failed: ' + r.status + ' ' + txt);
  return JSON.parse(txt)[0];
}

async function patchBooking(id, patch) {
  const url = process.env.SUPABASE_URL;
  const r = await fetch(`${url}/rest/v1/bookings?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...supabaseHeaders(), 'Prefer': 'return=representation' },
    body: JSON.stringify(patch)
  });
  if (!r.ok) {
    const txt = await r.text();
    console.error('Booking patch failed:', r.status, txt);
  }
}

async function fetchPackByCode(code) {
  const url = process.env.SUPABASE_URL;
  const qs = `select=*&access_code=eq.${encodeURIComponent(code)}&limit=1`;
  const r = await fetch(`${url}/rest/v1/session_packs?${qs}`, {
    headers: supabaseHeaders()
  });
  if (!r.ok) throw new Error('Pack fetch failed: ' + r.status);
  return (await r.json())[0];
}

/**
 * Optimistic-concurrency decrement: only succeeds if `sessions_used` is still
 * `currentUsed` and `status` is still `active`. Returns the updated row, or
 * undefined if the pack changed underneath us.
 */
async function decrementPackAtomic(pack) {
  const url       = process.env.SUPABASE_URL;
  const newUsed   = pack.sessions_used + 1;
  const newStatus = newUsed >= pack.total_sessions ? 'exhausted' : 'active';
  const patchUrl  = `${url}/rest/v1/session_packs`
                  + `?id=eq.${pack.id}`
                  + `&sessions_used=eq.${pack.sessions_used}`
                  + `&status=eq.active`;
  const r = await fetch(patchUrl, {
    method: 'PATCH',
    headers: { ...supabaseHeaders(), 'Prefer': 'return=representation' },
    body: JSON.stringify({ sessions_used: newUsed, status: newStatus })
  });
  if (!r.ok) throw new Error('Pack update failed: ' + r.status);
  const rows = await r.json();
  return rows[0]; // undefined if nothing matched the filters
}

/**
 * Reverse a pack decrement (used to compensate when booking insert fails).
 * Best-effort — logs on failure.
 */
async function incrementPackOnFailure(pack, intendedStatus) {
  try {
    const url = process.env.SUPABASE_URL;
    await fetch(`${url}/rest/v1/session_packs?id=eq.${pack.id}`, {
      method: 'PATCH',
      headers: supabaseHeaders(),
      body: JSON.stringify({ sessions_used: pack.sessions_used, status: intendedStatus })
    });
  } catch (err) {
    console.error('Pack rollback failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Common slot-conflict check (calendar + active holds + confirmed bookings)
// ---------------------------------------------------------------------------
async function checkSlotAvailable(token, date, slotStartMs, slotEndMs) {
  const dayStartUtc = new Date(awstToUtcMs(date, 0, 0)).toISOString();
  const dayEndUtc   = new Date(awstToUtcMs(date, 24, 0)).toISOString();
  const [calBusy, activeBookings, blocks] = await Promise.all([
    fetchCalendarBusy(token, dayStartUtc, dayEndUtc),
    fetchActiveBookingsForDay(date),
    fetchBlocksForDay(date)
  ]);
  const bookingBusy = activeBookings.map(b => {
    const [sh, sm] = b.session_slot.split(':').map(Number);
    const [eh, em] = b.session_end.split(':').map(Number);
    return {
      start: new Date(awstToUtcMs(date, sh, sm)).toISOString(),
      end:   new Date(awstToUtcMs(date, eh, em)).toISOString()
    };
  });
  const bufMs = BUFFER_MIN * 60 * 1000;
  return !slotConflictsWith(slotStartMs, slotEndMs, [...calBusy, ...bookingBusy, ...blocks], bufMs);
}

// ---------------------------------------------------------------------------
// Path 1: Single session (Stripe redirect)
// ---------------------------------------------------------------------------
async function handleSingleSession(res, slotInfo) {
  const stripeLink = process.env.STRIPE_PAYMENT_LINK;
  if (!stripeLink) return bad(res, 500, 'Stripe payment link not configured');

  const token = await getGoogleAccessToken();
  const ok = await checkSlotAvailable(token, slotInfo.date, slotInfo.slotStartMs, slotInfo.slotEndMs);
  if (!ok) return bad(res, 409, 'That slot was just taken. Please pick another time.');

  const expiresAt = new Date(Date.now() + HOLD_MIN * 60 * 1000).toISOString();
  const saved = await insertBooking({
    session_date:   slotInfo.date,
    session_slot:   slotInfo.slot + ':00',
    session_end:    slotInfo.endHhMm,
    client_name:    slotInfo.name,
    client_email:   slotInfo.email,
    client_mobile:  slotInfo.mobile,
    status:         'pending',
    expires_at:     expiresAt
  });

  const url = new URL(stripeLink);
  url.searchParams.set('client_reference_id', saved.id);
  url.searchParams.set('prefilled_email', slotInfo.email);

  res.status(200).json({
    ok:         true,
    booking_id: saved.id,
    url:        url.toString(),
    expires_at: expiresAt
  });
}

// ---------------------------------------------------------------------------
// Path 1b: Pack purchase WITH first-session booking
//   Same shape as single session, except we redirect to the pack Payment Link
//   (so the webhook generates an access code) AND set client_reference_id so
//   the webhook knows to also confirm + calendar the linked booking.
// ---------------------------------------------------------------------------
async function handlePackPurchaseWithFirstSession(res, slotInfo) {
  const packLink = process.env.STRIPE_PACK_PAYMENT_LINK || PACK_LINK_FALLBACK;

  const token = await getGoogleAccessToken();
  const ok    = await checkSlotAvailable(token, slotInfo.date, slotInfo.slotStartMs, slotInfo.slotEndMs);
  if (!ok) return bad(res, 409, 'That slot was just taken. Please pick another time.');

  const expiresAt = new Date(Date.now() + HOLD_MIN * 60 * 1000).toISOString();
  const saved = await insertBooking({
    session_date:   slotInfo.date,
    session_slot:   slotInfo.slot + ':00',
    session_end:    slotInfo.endHhMm,
    client_name:    slotInfo.name,
    client_email:   slotInfo.email,
    client_mobile:  slotInfo.mobile,
    status:         'pending',
    expires_at:     expiresAt
  });

  const url = new URL(packLink);
  url.searchParams.set('client_reference_id', saved.id);
  url.searchParams.set('prefilled_email', slotInfo.email);

  res.status(200).json({
    ok:         true,
    booking_id: saved.id,
    url:        url.toString(),
    expires_at: expiresAt,
    mode:       'pack_purchase'
  });
}

// ---------------------------------------------------------------------------
// Path 2: Pack redemption (no Stripe, immediate confirmation)
// ---------------------------------------------------------------------------
async function handlePackRedemption(res, slotInfo, packCode) {
  const code = packCode.trim().toUpperCase();
  if (!isValidAccessCode(code)) return bad(res, 400, 'Invalid access code format');

  const pack = await fetchPackByCode(code);
  if (!pack)                                                   return bad(res, 404, 'Access code not found');
  if (pack.status !== 'active')                                return bad(res, 410, `This pack is ${pack.status}`);
  if (new Date(pack.expires_at).getTime() < Date.now())        return bad(res, 410, 'This pack has expired');
  if (pack.sessions_used >= pack.total_sessions)               return bad(res, 410, 'No sessions remaining in this pack');

  // Slot conflict check (same logic as singles)
  const token = await getGoogleAccessToken();
  const slotOk = await checkSlotAvailable(token, slotInfo.date, slotInfo.slotStartMs, slotInfo.slotEndMs);
  if (!slotOk) return bad(res, 409, 'That slot was just taken. Please pick another time.');

  // Atomic decrement — only succeeds if the pack hasn't been touched since we read it
  const updatedPack = await decrementPackAtomic(pack);
  if (!updatedPack) {
    return bad(res, 409, 'Pack changed while booking. Please refresh and try again.');
  }

  // Insert confirmed booking with pack_id. If this fails, roll back the pack decrement.
  let booking;
  try {
    booking = await insertBooking({
      session_date:   slotInfo.date,
      session_slot:   slotInfo.slot + ':00',
      session_end:    slotInfo.endHhMm,
      client_name:    slotInfo.name,
      client_email:   slotInfo.email,
      client_mobile:  slotInfo.mobile,
      session_type:   'pack',
      status:         'confirmed',
      confirmed_at:   new Date().toISOString(),
      pack_id:        pack.id
    });
  } catch (err) {
    console.error('Booking insert failed after pack decrement — rolling back pack:', err);
    await incrementPackOnFailure(pack, pack.status);
    throw err;
  }

  // Calendar event + emails. Failures here don't undo the booking — they get logged
  // so Sev can manually patch on the rare miss.
  const remaining      = pack.total_sessions - (pack.sessions_used + 1);
  const remainingLabel = `${remaining} of ${pack.total_sessions} session${pack.total_sessions === 1 ? '' : 's'} remaining.`;

  let calEventLink = null, meetLink = null, calEventId = null;
  try {
    const evt = await createCalendarEvent(token, { ...booking, pack_id: pack.id });
    calEventId   = evt.id;
    calEventLink = evt.htmlLink;
    meetLink     = evt.hangoutLink ||
      (evt.conferenceData && evt.conferenceData.entryPoints &&
       (evt.conferenceData.entryPoints.find(e => e.entryPointType === 'video') || {}).uri);

    await patchBooking(booking.id, {
      calendar_event_id:   calEventId,
      calendar_event_link: calEventLink,
      meet_link:           meetLink
    });
  } catch (err) {
    console.error('Pack-redeem calendar event creation failed:', err);
  }

  sendBookingConfirmationEmails(
    { ...booking, pack_id: pack.id, pack_remaining_label: remainingLabel },
    meetLink,
    calEventLink
  ).catch(err => console.error('Pack-redeem email send failed:', err));

  res.status(200).json({
    ok:         true,
    booking_id: booking.id,
    url:        PACK_REDEEM_REDIRECT,
    pack: {
      sessions_used:      pack.sessions_used + 1,
      sessions_remaining: remaining,
      total_sessions:     pack.total_sessions,
      status:             updatedPack.status
    }
  });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST')    { bad(res, 405, 'Method not allowed'); return; }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return bad(res, 400, 'Invalid JSON'); }
  }
  if (!body || typeof body !== 'object') return bad(res, 400, 'Missing body');

  // --- Validate the slot + customer fields (same rules for both paths) -----
  const name      = clean(body.name, 120);
  const email     = clean(body.email, 200);
  const mobile    = clean(body.mobile, 30);
  const date      = clean(body.date, 10);
  const slot      = clean(body.slot, 5);
  const pack_code = body.pack_code != null ? clean(body.pack_code, 32) : null;
  const mode      = clean(body.mode, 30);

  if (!name)                       return bad(res, 400, 'Name required');
  if (!validateEmail(email))       return bad(res, 400, 'Invalid email');
  if (!validateAuMobile(mobile))   return bad(res, 400, 'Invalid AU mobile');
  if (!isValidDate(date))          return bad(res, 400, 'Invalid date');
  if (!isValidSlot(slot))          return bad(res, 400, 'Invalid slot');

  const [hh, mm]    = slot.split(':').map(Number);
  const slotStartMs = awstToUtcMs(date, hh, mm);
  const slotEndMs   = slotStartMs + SESSION_LEN_MIN * 60 * 1000;
  const end         = addMinutes(date, hh, mm, SESSION_LEN_MIN);

  if (slotStartMs < Date.now()) return bad(res, 400, 'Slot is in the past');

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return bad(res, 500, 'Supabase not configured');

  const slotInfo = {
    date, slot, slotStartMs, slotEndMs,
    endHhMm: end.hhMm,
    name, email, mobile
  };

  try {
    if (pack_code) {
      await handlePackRedemption(res, slotInfo, pack_code);
    } else if (mode === 'pack_purchase') {
      await handlePackPurchaseWithFirstSession(res, slotInfo);
    } else {
      await handleSingleSession(res, slotInfo);
    }
  } catch (err) {
    console.error('Create-booking error:', err);
    if (!res.headersSent) res.status(500).json({ ok: false, error: 'Server error' });
  }
};
