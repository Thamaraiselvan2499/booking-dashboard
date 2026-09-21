require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.static(__dirname));

// Zoho API Configuration
const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REDIRECT_URI = process.env.ZOHO_REDIRECT_URI;
const ZOHO_SHEET_ID = process.env.ZOHO_SHEET_ID;
const ZOHO_ACCOUNTS_URL = 'https://accounts.zoho.in'; 

let refreshToken = process.env.ZOHO_REFRESH_TOKEN || '';

// 1. Redirect user to Zoho for authorization
app.get('/api/auth', (req, res) => {
  const authUrl = `${ZOHO_ACCOUNTS_URL}/oauth/v2/auth?scope=ZohoSheet.dataAPI.READ&client_id=${ZOHO_CLIENT_ID}&response_type=code&redirect_uri=${ZOHO_REDIRECT_URI}&access_type=offline&prompt=consent`;
  res.redirect(authUrl);
});

// 2. Handle the callback from Zoho
app.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code provided');

  try {
    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('client_id', ZOHO_CLIENT_ID);
    params.append('client_secret', ZOHO_CLIENT_SECRET);
    params.append('redirect_uri', ZOHO_REDIRECT_URI);
    params.append('code', code);

    const response = await axios.post(`${ZOHO_ACCOUNTS_URL}/oauth/v2/token`, params);

    if (response.data.refresh_token) {
      refreshToken = response.data.refresh_token;
      console.log('✅ Authorization successful! Refresh Token stored.');
      console.log('👉 IMPORTANT: COPY THIS REFRESH TOKEN TO RENDER ENV VARIABLES:', refreshToken);
      res.send('Authorization successful! Check the server logs for your Refresh Token.');
    } else {
      console.error('❌ No refresh token returned. Response:', response.data);
      res.status(500).send('No refresh token returned.');
    }
  } catch (error) {
    console.error('❌ Error during authorization:', error.response?.data || error.message);
    res.status(500).send('Authorization failed.');
  }
});

// 3. Get a fresh access token using the refresh token
async function getAccessToken() {
  if (!refreshToken) {
    console.error("❌ ERROR: refreshToken is empty.");
    throw new Error('No refresh token available.');
  }
  
  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('client_id', ZOHO_CLIENT_ID);
  params.append('client_secret', ZOHO_CLIENT_SECRET);
  params.append('refresh_token', refreshToken);

  const response = await axios.post(`${ZOHO_ACCOUNTS_URL}/oauth/v2/token`, params);
  console.log("✅ Successfully got new Access Token from Zoho");
  return response.data.access_token;
}

// 4. Fetch live data from Zoho Sheet using the JSON Data API
app.get('/api/data', async (req, res) => {
  try {
    console.log("🔄 Sync Now clicked. Fetching JSON data from Zoho...");
    const accessToken = await getAccessToken();
    
    // The 'method' parameter must be in the URL as a query string for POST requests.
    const summaryUrl = `https://sheet.zoho.in/api/v2/${ZOHO_SHEET_ID}?method=worksheet.records.fetch`;
    const wreUrl = `https://sheet.zoho.in/api/v2/${ZOHO_SHEET_ID}?method=worksheet.records.fetch`;

    // Fetch Overall Summary
    const summaryRes = await axios.post(summaryUrl, {
      worksheet_name: 'Overall Summary'
    }, {
      headers: { 
        'Authorization': `Zoho-oauthtoken ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    // Fetch WRE Mapping
    const wreRes = await axios.post(wreUrl, {
      worksheet_name: 'WRE Mapping'
    }, {
      headers: { 
        'Authorization': `Zoho-oauthtoken ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    // Helper to convert Zoho's array-of-arrays response to array-of-objects
    const parseSheetData = (response) => {
      // Zoho's response structure for worksheet.records.fetch
      if (!response.data || !response.data.data) return [];
      const rows = response.data.data;
      if (rows.length < 2) return [];
      const headers = rows[0];
      const data = [];
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const obj = {};
        headers.forEach((header, index) => {
          obj[header] = row[index] !== undefined ? row[index] : '';
        });
        data.push(obj);
      }
      return data;
    };

    const summary = parseSheetData(summaryRes);
    const wre = parseSheetData(wreRes);

    console.log(`✅ Successfully fetched live JSON data: ${summary.length} summary rows, ${wre.length} WRE rows`);
    res.json({ summary, wre });

  } catch (err) {
    console.error('❌ API ERROR:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
