// Vercel Function: POST /api/submit-lead
//
// Validates the apply-form payload, inserts a row into Supabase using the
// service_role key (server-side only), and fires a Resend confirmation email
// to the lead. Returns 200 on success, 4xx on validation error, 5xx on
// internal failure.
//
// Required environment variables (set in Vercel dashboard or via `vercel env add`):
//   SUPABASE_URL              — https://<project-ref>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY — service_role key (NEVER expose to the client)
//   RESEND_API_KEY            — Resend API key
//   RESEND_FROM_EMAIL         — verified from address, e.g. "Sev <sev@talktosev.com>"
//   RESEND_REPLY_TO           — optional, defaults to sev@sevspics.com
//
// Notes:
//   - This file runs as a Node.js serverless function on Vercel.
//   - No npm install needed: we use native fetch (Node 18+) for both Supabase
//     REST and the Resend API. Keeps the repo zero-build, matching the rest
//     of the site.

const VALID_RECORD_BLOCKER   = ['sound_awkward', 'dont_know_what_to_say', 'hate_how_i_look', 'freeze_up'];
const VALID_SIX_MONTH_VISION = ['grow_business', 'build_brand', 'sell_course', 'face_of_industry'];
const VALID_VIDEO_HISTORY    = ['post_regularly', 'gave_up', 'never'];
const VALID_REVENUE_BRACKET  = ['over_20k', 'under_20k'];
const VALID_HOW_FOUND        = ['ig_content', 'friend', 'ad', 'other'];

function bad(res, code, msg) {
  res.status(code).json({ ok: false, error: msg });
}

function clean(value, max = 500) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.slice(0, max);
}

function validateEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function validatePhone(s) {
  if (typeof s !== 'string') return false;
  const digits = s.replace(/\D/g, '');
  return digits.length >= 6 && digits.length <= 15;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildEmailHtml({ firstName, qualified }) {
  const safeName = escapeHtml(firstName || 'there');
  const followBlock = qualified
    ? `<p style="margin:0 0 16px;">But honestly — let's just hop on a quick call this week. I've held some time for you here:</p>
       <p style="margin:0 0 24px;">
         <a href="https://calendly.com/sevamozhaev/ask-me-anything"
            style="display:inline-block;background:#f5a524;color:#1a1100;
                   padding:12px 22px;border-radius:8px;text-decoration:none;
                   font-weight:600;">Book a 15-minute call →</a>
       </p>`
    : `<p style="margin:0 0 16px;">While you wait, go follow me on Instagram and tag me in something you've posted. I want to see what you're working with.</p>
       <p style="margin:0 0 24px;">
         <a href="https://instagram.com/sevspics"
            style="display:inline-block;background:#f5a524;color:#1a1100;
                   padding:12px 22px;border-radius:8px;text-decoration:none;
                   font-weight:600;">Follow @sevspics →</a>
       </p>`;

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#0a0a0a;color:#e8e8e8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:16px;line-height:1.55;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0a0a0a;">
    <tr><td align="center" style="padding:40px 20px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#111111;border:1px solid #1d1d1d;border-radius:12px;padding:36px 32px;">
        <tr><td>
          <p style="margin:0 0 8px;font-family:'IBM Plex Mono',monospace;font-size:0.78rem;letter-spacing:0.1em;text-transform:uppercase;color:#f5a524;">Talk To Sev</p>
          <h1 style="margin:0 0 18px;font-size:28px;line-height:1.15;color:#ffffff;font-weight:600;letter-spacing:-0.02em;">You're in, ${safeName}.</h1>
          <p style="margin:0 0 16px;">Thanks for filling out the form. I read every one of these myself, so this isn't going into a black hole.</p>
          <p style="margin:0 0 16px;">Your free <strong style="color:#ffffff;">60-second confidence review</strong> lands in your inbox within 48 hours. I'll record a quick voice memo back walking you through what's working in your content and the first thing I'd change.</p>
          ${followBlock}
          <hr style="border:none;border-top:1px solid #1d1d1d;margin:28px 0;">
          <p style="margin:0;color:#8a8a8a;font-size:0.9rem;">— Sev<br>
          <a href="https://talktosev.com" style="color:#8a8a8a;text-decoration:underline;">talktosev.com</a></p>
        </td></tr>
      </table>
      <p style="margin:20px 0 0;color:#5a5a5a;font-size:0.78rem;">If this wasn't you, just delete this email and I won't bother you again.</p>
    </td></tr>
  </table>
</body></html>`;
}

function buildEmailText({ firstName, qualified }) {
  const followBlock = qualified
    ? `But honestly — let's just hop on a quick call this week. I've held some time for you here:\nhttps://calendly.com/sevamozhaev/ask-me-anything`
    : `While you wait, go follow me on Instagram and tag me in something you've posted. I want to see what you're working with.\nhttps://instagram.com/sevspics`;

  return `You're in, ${firstName || 'there'}.

Thanks for filling out the form. I read every one of these myself, so this isn't going into a black hole.

Your free 60-second confidence review lands in your inbox within 48 hours. I'll record a quick voice memo back walking you through what's working in your content and the first thing I'd change.

${followBlock}

— Sev
https://talktosev.com

If this wasn't you, just delete this email and I won't bother you again.`;
}

async function insertLead(payload) {
  const url  = process.env.SUPABASE_URL;
  const key  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env vars missing');

  const res = await fetch(url + '/rest/v1/leads', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        key,
      'Authorization': 'Bearer ' + key,
      'Prefer':        'return=representation'
    },
    body: JSON.stringify(payload)
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error('Supabase insert failed: ' + res.status + ' ' + body);
  }
  return JSON.parse(body);
}

async function sendConfirmationEmail({ toEmail, firstName, qualified }) {
  const key  = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL || 'Sev <sev@talktosev.com>';
  const reply = process.env.RESEND_REPLY_TO || 'sev@sevspics.com';
  if (!key) {
    console.warn('RESEND_API_KEY missing — skipping confirmation email');
    return;
  }

  const subject = qualified
    ? "You're in. Let's book the call."
    : "You're in. Your camera audit is coming.";

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': 'Bearer ' + key
    },
    body: JSON.stringify({
      from,
      to: [toEmail],
      reply_to: reply,
      subject,
      html: buildEmailHtml({ firstName, qualified }),
      text: buildEmailText({ firstName, qualified })
    })
  });
  if (!res.ok) {
    const txt = await res.text();
    console.error('Resend send failed:', res.status, txt);
    // Don't throw — the lead is already saved. Email failure shouldn't break submit.
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
module.exports = async function handler(req, res) {
  // CORS not strictly needed (same-origin) but harmless to allow.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { bad(res, 405, 'Method not allowed'); return; }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { bad(res, 400, 'Invalid JSON'); return; }
  }
  if (!body || typeof body !== 'object') { bad(res, 400, 'Missing body'); return; }

  // ---- Validation ------------------------------------------------------
  if (!VALID_RECORD_BLOCKER.includes(body.record_blocker))     return bad(res, 400, 'Invalid record_blocker');
  if (!VALID_SIX_MONTH_VISION.includes(body.six_month_vision)) return bad(res, 400, 'Invalid six_month_vision');
  if (!VALID_VIDEO_HISTORY.includes(body.video_history))       return bad(res, 400, 'Invalid video_history');
  if (!VALID_REVENUE_BRACKET.includes(body.revenue_bracket))   return bad(res, 400, 'Invalid revenue_bracket');
  if (!VALID_HOW_FOUND.includes(body.how_found))               return bad(res, 400, 'Invalid how_found');

  const firstName = clean(body.first_name, 60);
  const lastName  = clean(body.last_name, 60);
  if (!firstName || !lastName) return bad(res, 400, 'Name required');

  const instagram = clean(body.instagram_handle, 80);
  if (!instagram) return bad(res, 400, 'Instagram required');

  if (!validateEmail(body.email)) return bad(res, 400, 'Invalid email');
  if (!validatePhone(body.phone)) return bad(res, 400, 'Invalid phone');

  if (body.how_found === 'other' && !clean(body.how_found_other, 120)) {
    return bad(res, 400, 'how_found_other required when how_found is "other"');
  }

  // ---- Build the DB row ------------------------------------------------
  const row = {
    record_blocker:   body.record_blocker,
    six_month_vision: body.six_month_vision,
    video_history:    body.video_history,
    revenue_bracket:  body.revenue_bracket,
    first_name:       firstName,
    last_name:        lastName,
    instagram_handle: instagram,
    business_detail:  clean(body.business_detail, 2000),
    email:            String(body.email).trim().toLowerCase(),
    phone:            clean(body.phone, 30),
    phone_country:    clean(body.phone_country, 4) || 'AU',
    how_found:        body.how_found,
    how_found_other:  body.how_found === 'other' ? clean(body.how_found_other, 120) : null,
    user_agent:       clean(body.user_agent, 500),
    referrer:         clean(body.referrer, 500)
  };

  try {
    const [saved] = await insertLead(row);
    // Fire confirmation email (best-effort, doesn't block)
    sendConfirmationEmail({
      toEmail:   row.email,
      firstName: row.first_name,
      qualified: row.revenue_bracket === 'over_20k'
    }).catch(err => console.error('Email send threw:', err));

    res.status(200).json({ ok: true, id: saved && saved.id });
  } catch (err) {
    console.error('Submit-lead error:', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
};
