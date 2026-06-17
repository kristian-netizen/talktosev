// Vercel Function: POST /api/stripe-webhook
//
// Receives Stripe's `checkout.session.completed` event and routes it:
//
//   1) Single-session purchase  (client_reference_id set; matches a pending booking)
//      → mark booking confirmed, create Calendar event, send emails.
//
//   2) 4-Session Pack purchase  (session.payment_link === STRIPE_PACK_PAYMENT_LINK_ID)
//      → generate access code, insert into session_packs, email the customer.
//
// Required env vars:
//   STRIPE_WEBHOOK_SECRET
//   STRIPE_PACK_PAYMENT_LINK_ID      (plink_..., for detecting pack purchases)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
//   RESEND_API_KEY, RESEND_FROM_EMAIL
//
// Vercel: disable body parsing so we can verify the raw payload signature.

const crypto = require('crypto');
const {
  supabaseHeaders,
  getGoogleAccessToken,
  createCalendarEvent,
  sendBookingConfirmationEmails,
  sendPackReadyEmails,
  generateAccessCode,
  // Used by the pack-with-first-session path to re-verify the slot is still free
  // by the time Stripe's webhook arrives.
  SESSION_LEN_MIN,
  awstToUtcMs,
  fetchCalendarBusy,
  fetchActiveBookingsForDay,
  slotConflictsWith,
  formatAwst
} = require('../lib/booking-helpers');

const PACK_TOTAL_SESSIONS   = 4;
const PACK_EXPIRY_DAYS      = 90;     // 3 months
const ACCESS_CODE_MAX_TRIES = 5;      // retry on unique-constraint collision
const BUFFER_MIN            = 0;

// ---------------------------------------------------------------------------
// Raw body reader (Stripe signature verification needs the exact bytes)
// ---------------------------------------------------------------------------
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data',  c => chunks.push(c));
    req.on('end',   () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifyStripeSig(rawBody, sigHeader, secret, toleranceSec = 300) {
  if (!sigHeader || typeof sigHeader !== 'string') return false;
  const parts = Object.fromEntries(
    sigHeader.split(',').map(kv => kv.split('=').map(s => s.trim()))
  );
  const t  = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(t));
  if (!Number.isFinite(age) || age > toleranceSec) return false;

  const signedPayload = `${t}.${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(v1, 'hex'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Supabase helpers (single-booking lookup / patch)
// ---------------------------------------------------------------------------
async function getBookingById(id) {
  const url = process.env.SUPABASE_URL;
  const r = await fetch(`${url}/rest/v1/bookings?id=eq.${id}&select=*`, {
    headers: supabaseHeaders()
  });
  if (!r.ok) throw new Error('Booking fetch failed: ' + r.status);
  const rows = await r.json();
  return rows[0];
}

async function markBookingConfirmed(id, patch) {
  const url = process.env.SUPABASE_URL;
  const r = await fetch(`${url}/rest/v1/bookings?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...supabaseHeaders(), 'Prefer': 'return=representation' },
    body: JSON.stringify({
      status:       'confirmed',
      confirmed_at: new Date().toISOString(),
      ...patch
    })
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error('Booking patch failed: ' + r.status + ' ' + txt);
  }
}

async function patchBooking(id, patch) {
  const url = process.env.SUPABASE_URL;
  const r = await fetch(`${url}/rest/v1/bookings?id=eq.${id}`, {
    method: 'PATCH',
    headers: supabaseHeaders(),
    body: JSON.stringify(patch)
  });
  if (!r.ok) {
    const txt = await r.text();
    console.error('Booking patch failed:', r.status, txt);
  }
}

// Same shape as create-booking.js's checkSlotAvailable — re-verifies a slot
// against both Google Calendar busy ranges AND any other active bookings
// stored in Supabase. Used by the pack-with-first-session webhook path.
async function isSlotStillAvailable(token, dateStr, slotStartMs, slotEndMs) {
  const dayStartUtc = new Date(awstToUtcMs(dateStr, 0, 0)).toISOString();
  const dayEndUtc   = new Date(awstToUtcMs(dateStr, 24, 0)).toISOString();
  const [calBusy, activeBookings] = await Promise.all([
    fetchCalendarBusy(token, dayStartUtc, dayEndUtc),
    fetchActiveBookingsForDay(dateStr)
  ]);
  const bookingBusy = activeBookings.map(b => {
    const [sh, sm] = b.session_slot.split(':').map(Number);
    const [eh, em] = b.session_end.split(':').map(Number);
    return {
      start: new Date(awstToUtcMs(dateStr, sh, sm)).toISOString(),
      end:   new Date(awstToUtcMs(dateStr, eh, em)).toISOString()
    };
  });
  const bufMs = BUFFER_MIN * 60 * 1000;
  return !slotConflictsWith(slotStartMs, slotEndMs, [...calBusy, ...bookingBusy], bufMs);
}

// ---------------------------------------------------------------------------
// Pack purchase handler: insert a session_packs row + email the customer
// ---------------------------------------------------------------------------
async function insertSessionPack(row) {
  const url = process.env.SUPABASE_URL;
  const r = await fetch(`${url}/rest/v1/session_packs`, {
    method: 'POST',
    headers: { ...supabaseHeaders(), 'Prefer': 'return=representation' },
    body: JSON.stringify(row)
  });
  const txt = await r.text();
  if (!r.ok) {
    // Surface the body so the retry loop can detect a unique-violation on access_code
    const err = new Error('Pack insert failed: ' + r.status + ' ' + txt);
    err.status = r.status;
    err.body   = txt;
    throw err;
  }
  return JSON.parse(txt)[0];
}

// Retry loop around insertSessionPack — collision on access_code is
// astronomically unlikely but cheap to handle.
async function insertSessionPackWithRetry(baseRow) {
  let pack = null;
  let lastErr = null;
  for (let i = 0; i < ACCESS_CODE_MAX_TRIES; i++) {
    const code = generateAccessCode();
    try {
      pack = await insertSessionPack({ ...baseRow, access_code: code });
      break;
    } catch (err) {
      lastErr = err;
      if (err.status === 409 || /duplicate key|unique/i.test(err.body || '')) {
        console.warn('Access code collision, retrying...');
        continue;
      }
      throw err;
    }
  }
  if (!pack) throw lastErr || new Error('Failed to create pack after retries');
  return pack;
}

// Dispatcher: pack purchases route to one of two paths depending on whether
// the user pre-selected a first-session slot at checkout.
async function handlePackPurchase(session) {
  // Idempotency: has this Stripe session already produced a pack?
  const sUrl = process.env.SUPABASE_URL;
  const existing = await fetch(
    `${sUrl}/rest/v1/session_packs?stripe_session_id=eq.${session.id}&select=id&limit=1`,
    { headers: supabaseHeaders() }
  );
  if (existing.ok) {
    const rows = await existing.json();
    if (rows && rows[0]) {
      console.log('Pack already exists for session', session.id);
      return { ok: true, already: true };
    }
  }

  if (session.client_reference_id) {
    return handlePackPurchaseWithBooking(session);
  }
  return handlePackPurchaseOnly(session);
}

// Legacy path: customer clicked the hosted Stripe Payment Link directly
// (no first session pre-selected). Just create the pack and email the code.
async function handlePackPurchaseOnly(session) {
  const cd        = session.customer_details || {};
  const name      = cd.name  || 'Customer';
  const email     = cd.email;
  const mobile    = cd.phone || null;
  const amount    = session.amount_total   || null;
  const currency  = (session.currency || 'aud').toLowerCase();

  if (!email) {
    console.error('Pack webhook: session has no customer email', session.id);
    return { ok: false, error: 'no email' };
  }

  const expiresAt = new Date(Date.now() + PACK_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const pack = await insertSessionPackWithRetry({
    customer_name:           name,
    customer_email:          email,
    customer_mobile:         mobile,
    total_sessions:          PACK_TOTAL_SESSIONS,
    sessions_used:           0,
    stripe_payment_intent_id: session.payment_intent || null,
    stripe_session_id:        session.id,
    amount_paid_cents:        amount,
    amount_currency:          currency,
    source:                   'stripe',
    expires_at:               expiresAt,
    status:                   'active'
  });

  // Email the customer + Sev. Don't block the webhook response on Resend.
  sendPackReadyEmails(pack).catch(err => console.error('Pack email send failed:', err));

  return { ok: true, pack_id: pack.id };
}

// New path: customer selected date/time/details at checkout. After payment
// clears we (a) create the pack, (b) book the first session in the calendar,
// (c) email both the booking confirmation and the access code.
//
// If the slot was taken between the user's click and the webhook firing
// (rare — the 15-minute hold protects most checkouts), the pack is still
// created (the customer paid) but with sessions_used=0 and the booking is
// cancelled. The pack-ready email apologises and routes them back to /book
// with the access code so they can pick a fresh time.
async function handlePackPurchaseWithBooking(session) {
  const bookingId = session.client_reference_id;
  const amount    = session.amount_total || null;
  const currency  = (session.currency || 'aud').toLowerCase();

  const booking = await getBookingById(bookingId);
  if (!booking) {
    console.warn('Pack-with-booking webhook: booking not found, falling back to pack-only', bookingId);
    return handlePackPurchaseOnly(session);
  }

  // If the booking was already confirmed (Stripe retry / duplicate webhook),
  // bail. The idempotency check above on session_packs caught the pack side;
  // this catches the booking side as a backup.
  if (booking.status === 'confirmed') {
    console.log('Pack-with-booking webhook: booking already confirmed', bookingId);
    return { ok: true, already: true };
  }

  // Re-verify the slot is still free at webhook time.
  const token       = await getGoogleAccessToken();
  const [hh, mm]    = booking.session_slot.split(':').map(Number);
  const slotStartMs = awstToUtcMs(booking.session_date, hh, mm);
  const slotEndMs   = slotStartMs + SESSION_LEN_MIN * 60 * 1000;
  const slotOk      = await isSlotStillAvailable(token, booking.session_date, slotStartMs, slotEndMs);

  const expiresAt   = new Date(Date.now() + PACK_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // ---- Pack always gets created (customer paid) ------------------------
  const pack = await insertSessionPackWithRetry({
    customer_name:            booking.client_name,
    customer_email:           booking.client_email,
    customer_mobile:          booking.client_mobile,
    total_sessions:           PACK_TOTAL_SESSIONS,
    sessions_used:            slotOk ? 1 : 0,
    stripe_payment_intent_id: session.payment_intent || null,
    stripe_session_id:        session.id,
    amount_paid_cents:        amount,
    amount_currency:          currency,
    source:                   'stripe',
    expires_at:               expiresAt,
    status:                   'active'
  });

  // ---- Slot lost: cancel booking, send pack-only email with apology ----
  if (!slotOk) {
    console.warn('Pack-with-booking: slot taken before webhook fired; pack created, booking cancelled', bookingId);
    await patchBooking(booking.id, {
      status: 'cancelled',
      cancelled_at: new Date().toISOString()
    });
    sendPackReadyEmails(pack, { firstSessionLost: true })
      .catch(err => console.error('Pack-ready (slot-lost) email failed:', err));
    return { ok: true, pack_id: pack.id, first_session_booked: false };
  }

  // ---- Slot OK: book the first session ---------------------------------
  const enriched = {
    ...booking,
    pack_id:                pack.id,
    amount_paid_cents:      amount,
    amount_currency:        currency,
    stripe_session_id:      session.id,
    stripe_payment_intent:  session.payment_intent
  };

  let calEventId   = null;
  let calEventLink = null;
  let meetLink     = null;
  try {
    const evt   = await createCalendarEvent(token, enriched);
    calEventId   = evt.id;
    calEventLink = evt.htmlLink;
    meetLink     = evt.hangoutLink ||
      (evt.conferenceData && evt.conferenceData.entryPoints &&
       (evt.conferenceData.entryPoints.find(e => e.entryPointType === 'video') || {}).uri);
  } catch (err) {
    console.error('Pack-with-booking calendar create failed:', err);
    // Booking still confirmed below — Sev will see the missing link in his
    // email and can patch manually. Don't fail the whole webhook.
  }

  try {
    await markBookingConfirmed(booking.id, {
      pack_id:               pack.id,
      amount_paid_cents:     amount,
      amount_currency:       currency,
      stripe_session_id:     session.id,
      stripe_payment_intent: session.payment_intent,
      calendar_event_id:     calEventId,
      calendar_event_link:   calEventLink,
      meet_link:             meetLink
    });
  } catch (err) {
    console.error('Pack-with-booking confirm patch failed:', err);
    // Pack already exists; surface the partial-failure to Sev via the email below.
  }

  // ---- Emails: both pack-ready (first-session-booked variant) AND booking-confirmation
  const start  = formatAwst(booking.session_date, booking.session_slot);
  const end    = formatAwst(booking.session_date, booking.session_end);
  const remainingLabel = `${PACK_TOTAL_SESSIONS - 1} of ${PACK_TOTAL_SESSIONS} sessions remaining.`;

  sendPackReadyEmails(pack, {
    firstSessionBooked:    true,
    firstSessionDateLine:  start.dateLine,
    firstSessionTimeLine:  `${start.timeLine}–${end.timeLine} AWST`
  }).catch(err => console.error('Pack-ready (first-booked) email failed:', err));

  sendBookingConfirmationEmails(
    {
      ...enriched,
      pack_remaining_label: remainingLabel,
      calendar_event_id:    calEventId
    },
    meetLink,
    calEventLink
  ).catch(err => console.error('Booking-confirmation email failed:', err));

  return { ok: true, pack_id: pack.id, first_session_booked: true };
}

// ---------------------------------------------------------------------------
// Single-session purchase handler (existing flow, now using shared lib)
// ---------------------------------------------------------------------------
async function handleSingleSessionPurchase(session) {
  const bookingId     = session.client_reference_id;
  const stripeId      = session.id;
  const paymentIntent = session.payment_intent;
  const amount        = session.amount_total;
  const currency      = session.currency;

  if (!bookingId) {
    console.warn('Single-session webhook: no client_reference_id', stripeId);
    return { ok: true, error: 'no booking id' };
  }

  const booking = await getBookingById(bookingId);
  if (!booking) {
    console.warn('Webhook: booking not found', bookingId);
    return { ok: true, error: 'booking not found' };
  }
  if (booking.status === 'confirmed') {
    return { ok: true, already: true };
  }

  const enriched = {
    ...booking,
    amount_paid_cents:     amount     || booking.amount_paid_cents,
    amount_currency:       currency   || booking.amount_currency,
    stripe_session_id:     stripeId,
    stripe_payment_intent: paymentIntent
  };

  let calEventId   = null;
  let calEventLink = null;
  let meetLink     = null;
  try {
    const token = await getGoogleAccessToken();
    const evt   = await createCalendarEvent(token, enriched);
    calEventId   = evt.id;
    calEventLink = evt.htmlLink;
    meetLink     = evt.hangoutLink ||
      (evt.conferenceData && evt.conferenceData.entryPoints &&
       (evt.conferenceData.entryPoints.find(e => e.entryPointType === 'video') || {}).uri);
  } catch (err) {
    console.error('Calendar event creation failed:', err);
    // Don't block — still confirm + email so the client isn't stranded.
  }

  await markBookingConfirmed(bookingId, {
    amount_paid_cents:     enriched.amount_paid_cents,
    amount_currency:       enriched.amount_currency,
    stripe_session_id:     stripeId,
    stripe_payment_intent: paymentIntent,
    calendar_event_id:     calEventId,
    calendar_event_link:   calEventLink,
    meet_link:             meetLink
  });

  sendBookingConfirmationEmails(
    { ...enriched, calendar_event_id: calEventId },
    meetLink,
    calEventLink
  ).catch(err => console.error('Email send threw:', err));

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    console.error('Webhook body read failed:', err);
    res.status(400).end();
    return;
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const sig    = req.headers['stripe-signature'];
  if (!secret || !verifyStripeSig(rawBody, sig, secret)) {
    console.warn('Stripe signature verification failed');
    res.status(400).end();
    return;
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    res.status(400).end();
    return;
  }

  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ ok: true, ignored: event.type });
  }

  const session = event.data && event.data.object;
  if (!session) return res.status(200).json({ ok: true, error: 'no session' });

  const packPlinkId = process.env.STRIPE_PACK_PAYMENT_LINK_ID;
  const isPack      = packPlinkId && session.payment_link === packPlinkId;

  try {
    const result = isPack
      ? await handlePackPurchase(session)
      : await handleSingleSessionPurchase(session);
    return res.status(200).json(result);
  } catch (err) {
    console.error('Webhook processing error:', err);
    // 500 makes Stripe retry — desired for transient failures.
    return res.status(500).json({ ok: false });
  }
}

module.exports = handler;
module.exports.config = {
  api: { bodyParser: false }
};
