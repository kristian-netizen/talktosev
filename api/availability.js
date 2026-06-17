// Vercel Function: GET /api/availability?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Returns busy time ranges (in ISO UTC) for sev@sevspics.com's primary Google
// Calendar across the requested date range, plus any currently-held pending
// bookings from Supabase. The client uses these to disable conflicting slots.
//
// Required env vars:
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
//   GOOGLE_REFRESH_TOKEN
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

const { fetchBlocksInRange } = require('../lib/booking-helpers');

const TZ_OFFSET_HOURS = 8; // AWST = UTC+8, no DST

function bad(res, code, msg) {
  res.status(code).json({ ok: false, error: msg });
}

function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// Convert an AWST date (YYYY-MM-DD) to the UTC ISO bounds for that calendar day.
function awstDateToUtcBounds(yyyyMmDd) {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  // AWST midnight = UTC of previous day 16:00
  const startUtcMs = Date.UTC(y, m - 1, d, 0 - TZ_OFFSET_HOURS, 0, 0);
  const endUtcMs   = Date.UTC(y, m - 1, d, 24 - TZ_OFFSET_HOURS, 0, 0);
  return {
    timeMin: new Date(startUtcMs).toISOString(),
    timeMax: new Date(endUtcMs).toISOString()
  };
}

async function getGoogleAccessToken() {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Google env vars missing');
  }

  const params = new URLSearchParams({
    client_id:     clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type:    'refresh_token'
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params.toString()
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error('Google token refresh failed: ' + JSON.stringify(data));
  }
  return data.access_token;
}

async function fetchCalendarBusy(accessToken, timeMin, timeMax) {
  const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify({
      timeMin,
      timeMax,
      timeZone: 'Australia/Perth',
      items: [{ id: 'primary' }]
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('FreeBusy failed: ' + JSON.stringify(data));
  const cal = data.calendars && data.calendars.primary;
  if (cal && cal.errors && cal.errors.length) {
    throw new Error('FreeBusy errors: ' + JSON.stringify(cal.errors));
  }
  return (cal && cal.busy) || [];
}

async function fetchActiveHolds(fromDate, toDate) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env vars missing');

  const q = new URLSearchParams({
    select:         'session_date,session_slot,session_end,expires_at',
    status:         'eq.pending',
    expires_at:     'gt.' + new Date().toISOString(),
    session_date:   `gte.${fromDate}`,
    'session_date': `lte.${toDate}` // duplicate key intentional; URLSearchParams handles
  });
  // URLSearchParams overwrites duplicate keys — build manually instead
  const qs = `select=session_date,session_slot,session_end&status=eq.pending`
           + `&expires_at=gt.${encodeURIComponent(new Date().toISOString())}`
           + `&session_date=gte.${fromDate}&session_date=lte.${toDate}`;

  const res = await fetch(`${url}/rest/v1/bookings?${qs}`, {
    headers: {
      'apikey':        key,
      'Authorization': 'Bearer ' + key
    }
  });
  if (!res.ok) throw new Error('Supabase holds fetch failed: ' + res.status);
  const rows = await res.json();

  // Convert each held booking to a UTC busy range
  return rows.map(r => {
    const [y, m, d] = r.session_date.split('-').map(Number);
    const [sh, sm]  = r.session_slot.split(':').map(Number);
    const [eh, em]  = r.session_end.split(':').map(Number);
    const startUtc = Date.UTC(y, m - 1, d, sh - TZ_OFFSET_HOURS, sm);
    const endUtc   = Date.UTC(y, m - 1, d, eh - TZ_OFFSET_HOURS, em);
    return {
      start: new Date(startUtc).toISOString(),
      end:   new Date(endUtc).toISOString()
    };
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET')     { bad(res, 405, 'Method not allowed'); return; }

  const from = (req.query && req.query.from) || '';
  const to   = (req.query && req.query.to)   || '';
  if (!isValidDate(from) || !isValidDate(to)) {
    return bad(res, 400, 'from and to must be YYYY-MM-DD');
  }

  try {
    const { timeMin } = awstDateToUtcBounds(from);
    const { timeMax } = awstDateToUtcBounds(to);

    const token = await getGoogleAccessToken();
    const [calBusy, heldBusy, blockBusy] = await Promise.all([
      fetchCalendarBusy(token, timeMin, timeMax),
      fetchActiveHolds(from, to),
      fetchBlocksInRange(from, to)
    ]);

    const busy = [...calBusy, ...heldBusy, ...blockBusy].sort((a, b) =>
      new Date(a.start) - new Date(b.start)
    );

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, busy });
  } catch (err) {
    console.error('Availability error:', err);
    res.status(503).json({ ok: false, error: 'Availability service unavailable' });
  }
};
