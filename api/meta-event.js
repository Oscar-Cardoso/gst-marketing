// API de Conversões (Meta CAPI) para as landing pages — ex.: /AniversarioG2
// Precisa das variáveis de ambiente na Vercel:
//   META_CAPI_TOKEN  -> token de acesso da API de Conversões (Gerenciador de Eventos)
//   META_PIXEL_ID    -> opcional, padrão 213265871832015 (Pixel G2)
const crypto = require('crypto');

const ALLOWED_EVENTS = new Set(['PageView', 'Contact', 'Lead', 'ViewContent']);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  const token = process.env.META_CAPI_TOKEN;
  const pixelId = process.env.META_PIXEL_ID || '213265871832015';
  if (!token) return res.status(503).json({ ok: false, error: 'META_CAPI_TOKEN não configurado' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const { event_name, event_id, event_source_url, fbp, fbc, attribution } = body;
  if (!ALLOWED_EVENTS.has(event_name) || !event_id) return res.status(400).json({ ok: false });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress;
  const user_data = { client_ip_address: ip, client_user_agent: req.headers['user-agent'] || '' };
  if (fbp) user_data.fbp = String(fbp).slice(0, 500);
  if (fbc) user_data.fbc = String(fbc).slice(0, 500);

  const custom_data = { campaign_name: 'aniversario_g2_2026' };
  if (attribution && typeof attribution === 'object') {
    for (const [k, v] of Object.entries(attribution)) if (/^utm_/.test(k) && typeof v === 'string') custom_data[k] = v.slice(0, 200);
  }
  if (event_name === 'Contact') custom_data.contact_channel = 'whatsapp';

  const payload = {
    data: [{
      event_name,
      event_id: String(event_id).slice(0, 200),
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'website',
      event_source_url: typeof event_source_url === 'string' ? event_source_url.slice(0, 1000) : undefined,
      user_data,
      custom_data,
    }],
  };
  if (process.env.META_TEST_EVENT_CODE) payload.test_event_code = process.env.META_TEST_EVENT_CODE;

  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${pixelId}/events?access_token=${encodeURIComponent(token)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : 502).json({ ok: r.ok, events_received: j.events_received, error: j.error?.message });
  } catch (e) {
    return res.status(502).json({ ok: false });
  }
};
