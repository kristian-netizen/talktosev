// Vercel Function: /api/admin-blocks
//
// Manual availability management for /admin/availability.
//
//   GET    ?from=YYYY-MM-DD&to=YYYY-MM-DD   — list blocks + bookings in range
//   POST   { block_date, block_slot }       — create a block
//   DELETE ?id=<uuid>                       — remove a block
//
// Auth: Authorization: Bearer <ADMIN_PASSWORD> header on every request.
//
// Env vars: ADMIN_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const { supabaseHeaders } = require('../lib/booking-helpers');

const ALLOWED_SLOTS   = ['04:30', '05:30', '12:00', '15:00', '16:00', '17:00'];
const SLOT_DURATIONS  = { '04:30': 60, '05:30': 60, '12:00': 60, '15:00': 60, '16:00': 60, '17:00': 30 };

function bad(res, code, msg) {
  res.status(code).json({ ok: false, error: msg });
}

function authOk(req) {
  const auth = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!auth || typeof auth !== 'string') return false;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const password = m[1].trim();
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  // Constant-time compare via Buffer
  try {
    const crypto = require('crypto');
    const a = Buffer.from(password, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  if (!authOk(req)) return bad(res, 401, 'Unauthorized');

  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) return bad(res, 500, 'Supabase not configured');

  try {
    // -------- GET: list blocks + bookings in range -----------------------
    if (req.method === 'GET') {
      const from = req.query && req.query.from;
      const to   = req.query && req.query.to;
      if (!isValidDate(from) || !isValidDate(to)) {
        return bad(res, 400, 'from and to must be YYYY-MM-DD');
      }

      const blocksQs = `select=id,block_date,block_slot,duration_min,reason,created_at`
                     + `&block_date=gte.${from}&block_date=lte.${to}`
                     + `&order=block_date.asc,block_slot.asc`;
      const bookingsQs = `select=id,session_date,session_slot,session_end,client_name,client_email,status,session_type`
                       + `&session_date=gte.${from}&session_date=lte.${to}`
                       + `&status=in.(pending,confirmed)`
                       + `&order=session_date.asc,session_slot.asc`;

      const [blocksR, bookingsR] = await Promise.all([
        fetch(`${supabaseUrl}/rest/v1/slot_blocks?${blocksQs}`, { headers: supabaseHeaders() }),
        fetch(`${supabaseUrl}/rest/v1/bookings?${bookingsQs}`,  { headers: supabaseHeaders() })
      ]);
      if (!blocksR.ok)   throw new Error('Blocks list failed: '   + blocksR.status);
      if (!bookingsR.ok) throw new Error('Bookings list failed: ' + bookingsR.status);

      const blocks   = await blocksR.json();
      const bookings = await bookingsR.json();
      return res.status(200).json({ ok: true, blocks, bookings });
    }

    // -------- POST: create a block --------------------------------------
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { return bad(res, 400, 'Invalid JSON'); }
      }
      if (!body || typeof body !== 'object') return bad(res, 400, 'Missing body');

      const block_date = body.block_date;
      const block_slot = body.block_slot;
      const reason     = body.reason ? String(body.reason).slice(0, 280) : null;

      if (!isValidDate(block_date))           return bad(res, 400, 'Invalid block_date');
      if (!ALLOWED_SLOTS.includes(block_slot)) return bad(res, 400, 'Invalid block_slot');

      const duration_min = SLOT_DURATIONS[block_slot] || 60;

      const r = await fetch(`${supabaseUrl}/rest/v1/slot_blocks`, {
        method:  'POST',
        headers: { ...supabaseHeaders(), 'Prefer': 'return=representation' },
        body:    JSON.stringify({
          block_date,
          block_slot:    block_slot + ':00',
          duration_min,
          reason,
          created_by:    'admin'
        })
      });
      const txt = await r.text();
      if (!r.ok) {
        // Already blocked → idempotent success
        if (r.status === 409 || /duplicate key|unique/i.test(txt)) {
          return res.status(200).json({ ok: true, already: true });
        }
        return bad(res, r.status, 'Insert failed: ' + txt);
      }
      return res.status(200).json({ ok: true, block: JSON.parse(txt)[0] });
    }

    // -------- DELETE: remove a block ------------------------------------
    if (req.method === 'DELETE') {
      const id = (req.query && req.query.id) || '';
      if (!/^[0-9a-f-]{36}$/i.test(id)) return bad(res, 400, 'Invalid id');

      const r = await fetch(`${supabaseUrl}/rest/v1/slot_blocks?id=eq.${id}`, {
        method:  'DELETE',
        headers: supabaseHeaders()
      });
      if (!r.ok) return bad(res, r.status, 'Delete failed');
      return res.status(200).json({ ok: true });
    }

    return bad(res, 405, 'Method not allowed');
  } catch (err) {
    console.error('admin-blocks error:', err);
    if (!res.headersSent) res.status(500).json({ ok: false, error: 'Server error' });
  }
};
