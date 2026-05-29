const SUPA_URL = 'https://rybbojxebmmtfhbmnopm.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ5YmJvanhlYm1tdGZoYm1ub3BtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0OTA1NTIsImV4cCI6MjA5NTA2NjU1Mn0.OYK-XEqCfDc3ApMwyc4Dr6TEarsU9LuUsvt9yGoObio';

export default async function handler(req, res) {
  // CORS — só aceita do próprio domínio
  res.setHeader('Access-Control-Allow-Origin', 'https://agenciagst.com.br');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Prefer');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Pega o path e query string da request
  const { path = '', ...query } = req.query;
  const queryString = new URLSearchParams(query).toString();
  const targetPath = Array.isArray(path) ? path.join('/') : path;
  const url = `${SUPA_URL}/rest/v1/${targetPath}${queryString ? '?' + queryString : ''}`;

  const headers = {
    'apikey': SUPA_KEY,
    'Authorization': `Bearer ${SUPA_KEY}`,
    'Content-Type': 'application/json',
  };

  if (req.headers['prefer']) {
    headers['Prefer'] = req.headers['prefer'];
  }

  const fetchOptions = {
    method: req.method,
    headers,
  };

  if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
    fetchOptions.body = JSON.stringify(req.body);
  }

  try {
    const response = await fetch(url, fetchOptions);
    const text = await response.text();
    res.status(response.status);
    if (text) {
      res.json(JSON.parse(text));
    } else {
      res.end();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
