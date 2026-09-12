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

const CLIENT_ID     = process.env.ZOHO_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const REDIRECT_URI  = process.env.ZOHO_REDIRECT_URI;
const REGION        = process.env.ZOHO_REGION || 'in';
const PORT          = process.env.PORT || 3000;

const WORKBOOK_ID         = process.env.ZOHO_WORKBOOK_ID;
const REVENUE_WORKBOOK_ID = process.env.ZOHO_REVENUE_WORKBOOK_ID;
const SHEET_SUMMARY       = process.env.ZOHO_SUMMARY_SHEET_NAME;
const SHEET_WRE           = process.env.ZOHO_WRE_SHEET_NAME;

const AUTH_BASE  = `https://accounts.zoho.${REGION}`;
const SHEET_BASE = `https://sheet.zoho.${REGION}/api/v2`;
const TOKEN_FILE = path.join(__dirname, 'token-store.json');

/* ============================================================
   TOKENS
============================================================= */
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
    tokens.access_token  = data.access_token;
    tokens.refresh_token = data.refresh_token || tokens.refresh_token;
    tokens.expires_at    = Date.now() + (data.expires_in * 1000) - 60000;
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
  tokens.expires_at   = Date.now() + (data.expires_in * 1000) - 60000;
  saveTokens();
  return tokens.access_token;
}

async function zohoPost(workbookId, params) {
  const token = await getValidAccessToken();
  const url = `${SHEET_BASE}/${workbookId}`;
  const p = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => p.append(k, v));
  const { data } = await axios.post(url, p, {
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  });
  return data;
}

async function fetchRecords(workbookId, sheetName, extraParams = {}) {
  return zohoPost(workbookId, {
    method: 'worksheet.records.fetch',
    worksheet_name: sheetName,
    ...extraParams
  });
}

/* ============================================================
   NORMALISED KEY MATCHING
   Handles \n, multiple spaces, dashes, "Commision" typo
============================================================= */
function normKey(s) {
  return String(s)
    .replace(/[\n\r\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s*-\s*/g, ' - ')
    .replace(/commision/g, 'commission');
}

function buildLookup(rec) {
  const map = {};
  Object.keys(rec).forEach(k => { map[normKey(k)] = rec[k]; });
  return map;
}

function getField(lookup, ...candidates) {
  for (const c of candidates) {
    const nc = normKey(c);
    if (lookup[nc] !== undefined && lookup[nc] !== '') return lookup[nc];
  }
  return undefined;
}

/* ============================================================
   BOOKING DASHBOARD (unchanged)
============================================================= */
app.get('/api/data', async (req, res) => {
  try {
    const [summary, wre] = await Promise.all([
      fetchRecords(WORKBOOK_ID, SHEET_SUMMARY).catch(e => ({ error: e.message, records: [] })),
      fetchRecords(WORKBOOK_ID, SHEET_WRE).catch(e => ({ error: e.message, records: [] })),
    ]);
    res.json({
      summary: summary.records || summary,
      wre: wre.records || wre,
      errors: { summary: summary.error || null, wre: wre.error || null }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   REVENUE DASHBOARD — reads from flat "Data" tab
============================================================= */
const MONTHS = ['April','May','June','July','August','September','October','November','December'];

app.get('/api/revenue', async (req, res) => {
  try {
     const data = await fetchRecords(REVENUE_WORKBOOK_ID, 'Overall Sheet', { header_row: '1' });
    const rows = data.records || [];

    const records = rows
      .filter(r => {
        const n = r['Garage Name'];
        return n && String(n).trim() && !/^garage name$/i.test(String(n).trim());
      })
      .map(r => {
        const lk = buildLookup(r);
        const num = v => Number(v) || 0;

        const contract = num(getField(lk, 'Contract Value'));
        const cleared  = num(getField(lk, 'Cleared Net Amount'));
        const leads    = num(getField(lk, 'Commited Leads', 'Committed Leads'));

        const monthly = {};
        MONTHS.forEach(m => {
          monthly[m] = {
            invoice:       num(getField(lk, `${m} - Invoice`, `${m} Invoice`)),
            invoiceValue:  num(getField(lk, `${m} - Invoice Value (Without Tax)`, `${m} -Invoice Value (Without Tax)`, `${m} Invoice Value (Without Tax)`)),
            commission:    num(getField(lk, `${m} - Commission (Without Tax)`, `${m} -Commision (Without Tax)`, `${m} Commission (Without Tax)`)),
            avgBilling:    num(getField(lk, `${m} - Avg Billing`, `${m}- Avg Billing`, `${m} Avg Billing`)),
            commissionPct: num(getField(lk, `${m} - Commission(%)`, `${m} - Commision(%)`, `${m} Commission(%)`)),
          };
        });

        return {
          name: String(r['Garage Name']).trim(),
          location: String(r['Location'] || '').trim(),
          contract, cleared,
          outstanding: contract - cleared,
          leads,
          totalInvoice:       num(getField(lk, 'Total Invoice')),
          totalInvoiceValue:  num(getField(lk, 'Total Invoice Value (Without Tax)')),
          totalCommission:    num(getField(lk, 'Total Commission (Without Tax)', 'Total Commision (Without Tax)')),
          totalAvgBilling:    num(getField(lk, 'Total Avg Billing')),
          totalCommissionPct: num(getField(lk, 'Total Commission(%)', 'Total Commision(%)')),
          monthly
        };
      });

    res.json({
      records,
      meta: {
        total: records.length,
        source: 'Data tab',
        rawRowCount: rows.length,
        sampleKeys: rows[0] ? Object.keys(rows[0]) : []
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message, zohoResponse: err.response?.data || null });
  }
});

/* ============================================================
   DEBUG: list all worksheet names in the revenue workbook
============================================================= */
app.get('/api/revenue-debug', async (req, res) => {
  try {
    const data = await zohoPost(REVENUE_WORKBOOK_ID, { method: 'worksheet.list' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message, zohoResponse: err.response?.data || null });
  }
});

/* ============================================================
   START
============================================================= */
app.listen(PORT, () => {
  console.log(`\n✅ Server running: http://localhost:${PORT}`);
  console.log(`🔗 Authorize (once): http://localhost:${PORT}/auth`);
  console.log(`🔍 Debug (list sheets): http://localhost:${PORT}/api/revenue-debug\n`);
});