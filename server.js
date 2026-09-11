require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const REDIRECT_URI = process.env.ZOHO_REDIRECT_URI;
const REGION = process.env.ZOHO_REGION || 'in';
const PORT = process.env.PORT || 3000;
const WORKBOOK_ID = process.env.ZOHO_WORKBOOK_ID;
const SHEET_SUMMARY = process.env.ZOHO_SUMMARY_SHEET_NAME;
const SHEET_WRE = process.env.ZOHO_WRE_SHEET_NAME;

const AUTH_BASE = `https://accounts.zoho.${REGION}`;
const SHEET_BASE = `https://sheet.zoho.${REGION}/api/v2`;
const TOKEN_FILE = path.join(__dirname, 'token-store.json');

// --- Token Management (no changes here) ---
let tokens = { access_token: null, refresh_token: null, expires_at: 0 };
if (fs.existsSync(TOKEN_FILE)) {
  try { tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch (e) {}
}
function saveTokens() { fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2)); }

app.get('/auth', (req, res) => {
  const scopes = 'ZohoSheet.dataAPI.READ';
  const url = `${AUTH_BASE}/oauth/v2/auth?scope=${encodeURIComponent(scopes)}&client_id=${CLIENT_ID}&response_type=code&access_type=offline&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&prompt=consent`;
  res.redirect(url);
});

app.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');
  try {
    const { data } = await axios.post(`${AUTH_BASE}/oauth/v2/token`, null, {
      params: { grant_type: 'authorization_code', client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT_URI, code },
    });
    tokens.access_token = data.access_token;
    tokens.refresh_token = data.refresh_token || tokens.refresh_token;
    tokens.expires_at = Date.now() + (data.expires_in * 1000) - 60000;
    saveTokens();
    res.send('<h2>✅ Authorized. You can close this tab.</h2>');
  } catch (err) {
    res.status(500).send('Token exchange failed: ' + JSON.stringify(err.response?.data || err.message));
  }
});

async function getValidAccessToken() {
  if (tokens.access_token && Date.now() < tokens.expires_at) return tokens.access_token;
  if (!tokens.refresh_token) throw new Error('No refresh token. Visit /auth first.');
  const { data } = await axios.post(`${AUTH_BASE}/oauth/v2/token`, null, {
    params: { grant_type: 'refresh_token', client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: tokens.refresh_token },
  });
  tokens.access_token = data.access_token;
  tokens.expires_at = Date.now() + (data.expires_in * 1000) - 60000;
  saveTokens();
  return tokens.access_token;
}

// --- NEW: Corrected API Function (Uses POST) ---
async function fetchSheetRecords(sheetName) {
  const token = await getValidAccessToken();
  const url = `${SHEET_BASE}/${WORKBOOK_ID}`;
  
  // This is the critical fix: sending a POST request with the 'method' parameter
  const payload = new URLSearchParams();
  payload.append('method', 'worksheet.records.fetch');
  payload.append('worksheet_name', sheetName);

  const { data } = await axios.post(url, payload, {
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  });
  return data;
}

// --- Diagnostics Endpoint (Updated for POST) ---
app.get('/api/diagnose', async (req, res) => {
  let token;
  try {
    token = await getValidAccessToken();
  } catch (e) {
    return res.json({ fatal: 'Could not get access token', error: e.message });
  }
  const headers = {
    Authorization: `Zoho-oauthtoken ${token}`,
    'Content-Type': 'application/x-www-form-urlencoded'
  };

  const tests = {
    'fetch_records (POST)': async () => {
      const payload = new URLSearchParams();
      payload.append('method', 'worksheet.records.fetch');
      payload.append('worksheet_name', SHEET_SUMMARY);
      const r = await axios.post(`${SHEET_BASE}/${WORKBOOK_ID}`, payload, { headers });
      return { ok: true, status: r.status, preview: JSON.stringify(r.data).slice(0, 600) };
    },
    'list_worksheets (POST)': async () => {
      const payload = new URLSearchParams();
      payload.append('method', 'worksheet.list');
      const r = await axios.post(`${SHEET_BASE}/${WORKBOOK_ID}`, payload, { headers });
      return { ok: true, status: r.status, preview: JSON.stringify(r.data).slice(0, 600) };
    }
  };

  const results = {};
  for (const [name, testFn] of Object.entries(tests)) {
    try {
      results[name] = await testFn();
    } catch (e) {
      results[name] = {
        ok: false,
        status: e.response?.status,
        error: typeof e.response?.data === 'object' ? e.response.data : (e.response?.data || e.message)
      };
    }
  }
  res.json(results);
});

// --- Data Endpoint (Updated to use the working function) ---
app.get('/api/data', async (req, res) => {
  try {
    const [summary, wre] = await Promise.all([
      fetchSheetRecords(SHEET_SUMMARY).catch(e => ({ error: e.response?.data || e.message, records: [] })),
      fetchSheetRecords(SHEET_WRE).catch(e => ({ error: e.response?.data || e.message, records: [] })),
    ]);
    res.json({
      summary: summary.records || summary,
      wre: wre.records || wre,
      errors: {
        summary: summary.error || null,
        wre: wre.error || null
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Start Server ---
app.listen(PORT, () => {
  console.log(`\n✅ Server running: http://localhost:${PORT}`);
  console.log(`🔗 Authorize (once): http://localhost:${PORT}/auth`);
  console.log(`🔍 Diagnose: http://localhost:${PORT}/api/diagnose\n`);
});