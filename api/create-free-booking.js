// Vercel Function: POST /api/create-free-booking
//
// Books a FREE session in the Run-Claude-With-Me calendar. Two types:
//   - 'intro' → 60-min intro call @ 12:00 AWST
//   - 'quick' → 30-min quick chat  @ 17:00 AWST
//
// Same conflict logic as paid singles (Google Calendar busy + active bookings),
// but: no Stripe step, instant confirmation, rate-limited to one free booking
// per email per 30 days.
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
//   RESEND_API_KEY, RESEND_FROM_EMAIL

const {
  awstToUtcMs,
  addMinutes,
  getGoogleAccessToken,
  fetchCalendarBusy,
  createCalendarEvent,
  supabaseHeaders,
  fetchActiveBookingsForDay,
  fetchBlocksForDay,
  slotConflictsWith,
  sendFreeBookingConfirmationEmails
} = require('../lib/booking-helpers');

const LEAD_MS              = 24 * 60 * 60 * 1000;       // 24h minimum notice
const SPAM_WINDOW_MS       = 30 * 24 * 60 * 60 * 1000;  // 1 free booking / 30 days / email
const BUFFER_MIN           = 0;
const CONFIRMED_REDIRECT_BASE = 'https://www.talktosev.com/chat/confirmed';

// Two free-session shapes, keyed by the public `type` value from the request body.
const FREE_TYPES = {
  intro: { slot: '12:00', durationMin: 60, sessionType: 'free_intro' },
  quick: { slot: '17:00', durationMin: 30, sessionType: 'free_quick' }
};

// ---------------------------------------------------------------------------
// Validators
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

// ---------------------------------------------------------------------------
// Supabase: spam check + insert + patch
// ---------------------------------------------------------------------------
async function hasRecentFreeBooking(email) {
  const url   = process.env.SUPABASE_URL;
  const since = new Date(Date.now() - SPAM_WINDOW_MS).toISOString();
  const qs = `select=id`
           + `&client_email=eq.${encodeURIComponent(email)}`
           + `&session_type=in.(free_intro,free_quick)`
           + `&status=neq.cancelled`
           + `&created_at=gte.${encodeURIComponent(since)}`
           + `&limit=1`;
  const r = await fetch(`${url}/rest/v1/bookings?${qs}`, { headers: supabaseHeaders() });
  if (!r.ok) throw new Error('Spam check failed: ' + r.status);
  const rows = await r.json();
  return rows.length > 0;
}

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
    headers: supabaseHeaders(),
    body: JSON.stringify(patch)
  });
  if (!r.ok) {
    const txt = await r.text();
    console.error('Booking patch failed:', r.status, txt);
  }
}

// ---------------------------------------------------------------------------
// Conflict check
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

  const type   = clean(body.type, 10);
  const name   = clean(body.name, 120);
  const email  = clean(body.email, 200);
  const mobile = clean(body.mobile, 30);
  const date   = clean(body.date, 10);
  const notes  = clean(body.notes, 2000);

  const cfg = type && FREE_TYPES[type];
  if (!cfg)                       return bad(res, 400, 'Invalid session type');
  if (!name)                      return bad(res, 400, 'Name required');
  if (!validateEmail(email))      return bad(res, 400, 'Invalid email');
  if (!validateAuMobile(mobile))  return bad(res, 400, 'Invalid AU mobile');
  if (!isValidDate(date))         return bad(res, 400, 'Invalid date');

  const [hh, mm]    = cfg.slot.split(':').map(Number);
  const slotStartMs = awstToUtcMs(date, hh, mm);
  const slotEndMs   = slotStartMs + cfg.durationMin * 60 * 1000;
  const end         = addMinutes(date, hh, mm, cfg.durationMin);

  if (slotStartMs < Date.now() + LEAD_MS) {
    return bad(res, 400, 'Free bookings need at least 24 hours notice. Please pick a later day.');
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return bad(res, 500, 'Supabase not configured');

  try {
    // --- Rate limit: 1 free booking per email per 30 days -----------------
    if (await hasRecentFreeBooking(email)) {
      return bad(
        res, 429,
        "You've already booked a free session in the last 30 days. Email sev@sevspics.com if you need to chat sooner."
      );
    }

    // --- Slot conflict check ---------------------------------------------
    const token = await getGoogleAccessToken();
    const slotOk = await checkSlotAvailable(token, date, slotStartMs, slotEndMs);
    if (!slotOk) return bad(res, 409, 'That slot was just taken. Please pick another day.');

    // --- Insert as confirmed (no payment step) ----------------------------
    const booking = await insertBooking({
      session_date:  date,
      session_slot:  cfg.slot + ':00',
      session_end:   end.hhMm,
      client_name:   name,
      client_email:  email,
      client_mobile: mobile,
      notes:         notes,
      session_type:  cfg.sessionType,
      status:        'confirmed',
      confirmed_at:  new Date().toISOString()
    });

    // --- Calendar event + Meet link --------------------------------------
    let calEventId = null, calEventLink = null, meetLink = null;
    try {
      const evt = await createCalendarEvent(token, booking);
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
      console.error('Free-booking calendar event creation failed:', err);
    }

    // --- Fire-and-forget emails ------------------------------------------
    sendFreeBookingConfirmationEmails(booking, meetLink, calEventLink)
      .catch(err => console.error('Free-booking email send failed:', err));

    res.status(200).json({
      ok:         true,
      booking_id: booking.id,
      url:        `${CONFIRMED_REDIRECT_BASE}?type=${encodeURIComponent(type)}`
    });
  } catch (err) {
    console.error('Create-free-booking error:', err);
    if (!res.headersSent) res.status(500).json({ ok: false, error: 'Server error' });
  }
};
