// Vercel Function: GET /api/get-pack?code=PACK-XXXX-XXXX-XXXX
//
// Validates a pack access code and returns the pack's current state so the
// booking page can render the redemption UI (sessions remaining, expiry,
// client name pre-fill).
//
// Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const { isValidAccessCode, supabaseHeaders } = require('../lib/booking-helpers');

function bad(res, code, msg) {
  res.status(code).json({ ok: false, error: msg });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET')     { bad(res, 405, 'Method not allowed'); return; }

  const code = (req.query && req.query.code) ? String(req.query.code).trim().toUpperCase() : '';
  if (!isValidAccessCode(code)) return bad(res, 400, 'Invalid code format');

  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) return bad(res, 500, 'Supabase not configured');

  try {
    const qs = `select=id,customer_name,customer_email,total_sessions,sessions_used,expires_at,status`
             + `&access_code=eq.${encodeURIComponent(code)}`
             + `&limit=1`;
    const r = await fetch(`${supabaseUrl}/rest/v1/session_packs?${qs}`, {
      headers: supabaseHeaders()
    });
    if (!r.ok) throw new Error('Pack fetch failed: ' + r.status);
    const rows = await r.json();
    const pack = rows[0];
    if (!pack) return bad(res, 404, 'Code not found');

    const now = Date.now();
    const expired = new Date(pack.expires_at).getTime() < now;
    const remaining = Math.max(0, pack.total_sessions - pack.sessions_used);
    const exhausted = remaining <= 0;

    // Normalise the status the client renders against.
    let displayStatus = pack.status;
    if (displayStatus === 'active') {
      if (expired)        displayStatus = 'expired';
      else if (exhausted) displayStatus = 'exhausted';
    }

    res.status(200).json({
      ok: true,
      pack: {
        id:             pack.id,
        customer_name:  pack.customer_name,
        customer_email: pack.customer_email,
        total_sessions: pack.total_sessions,
        sessions_used:  pack.sessions_used,
        sessions_remaining: remaining,
        expires_at:     pack.expires_at,
        status:         displayStatus,
        redeemable:     displayStatus === 'active'
      }
    });
  } catch (err) {
    console.error('Get-pack error:', err);
    bad(res, 500, 'Server error');
  }
};
