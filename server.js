require('dotenv').config();
const express = require('express');
const XLSX = require('xlsx');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.static(__dirname));

// Zoho API Configuration
const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REDIRECT_URI = process.env.ZOHO_REDIRECT_URI;
const ZOHO_SHEET_ID = process.env.ZOHO_SHEET_ID;
const ZOHO_ACCOUNTS_URL = 'https://accounts.zoho.in'; // Use .in for India region

// Store refresh token in memory (and check env variable for persistence on Render)
let refreshToken = process.env.ZOHO_REFRESH_TOKEN || '';

// 1. Redirect user to Zoho for authorization
app.get('/api/auth', (req, res) => {
  const authUrl = `${ZOHO_ACCOUNTS_URL}/oauth/v2/auth?scope=ZohoSheet.dataAPI.READ&client_id=${ZOHO_CLIENT_ID}&response_type=code&redirect_uri=${ZOHO_REDIRECT_URI}&access_type=offline`;
  res.redirect(authUrl);
});

// 2. Handle the callback from Zoho
app.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code provided');

  try {
    const response = await axios.post(`${ZOHO_ACCOUNTS_URL}/oauth/v2/token`, null, {
      params: {
        grant_type: 'authorization_code',
        client_id: ZOHO_CLIENT_ID,
        client_secret: ZOHO_CLIENT_SECRET,
        redirect_uri: ZOHO_REDIRECT_URI,
        code: code
      }
    });

    refreshToken = response.data.refresh_token;
    console.log('✅ Authorization successful! Refresh Token stored.');
    console.log('👉 IMPORTANT: COPY THIS REFRESH TOKEN TO RENDER ENV VARIABLES:', refreshToken);
    res.send('Authorization successful! Please check the server logs for your Refresh Token and add it to Render Environment Variables as ZOHO_REFRESH_TOKEN.');
  } catch (error) {
    console.error('❌ Error during authorization:', error.response?.data || error.message);
    res.status(500).send('Authorization failed. Check the server logs.');
  }
});

// 3. Get a fresh access token using the refresh token
async function getAccessToken() {
  if (!refreshToken) throw new Error('No refresh token available. Please visit /api/auth first.');
  
  const response = await axios.post(`${ZOHO_ACCOUNTS_URL}/oauth/v2/token`, null, {
    params: {
      grant_type: 'refresh_token',
      client_id: ZOHO_CLIENT_ID,
      client_secret: ZOHO_CLIENT_SECRET,
      refresh_token: refreshToken
    }
  });
  return response.data.access_token;
}

// 4. Fetch live data from Zoho Sheet
app.get('/api/data', async (req, res) => {
  try {
    const accessToken = await getAccessToken();
    const filePath = path.join(__dirname, 'LiveZohoData.xlsx');

    // Download the live Excel file directly from Zoho Sheet
    const downloadUrl = `https://sheet.zoho.in/api/v2/${ZOHO_SHEET_ID}?format=xlsx`;
    const response = await axios.get(downloadUrl, {
      headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}` },
      responseType: 'arraybuffer'
    });

    // Save the file temporarily
    fs.writeFileSync(filePath, response.data);

    // Parse the downloaded file exactly like before
    const wb = XLSX.readFile(filePath);
    const summarySheet = wb.Sheets['Overall Summary'];
    const wreSheet = wb.Sheets['WRE Mapping'];

    if (!summarySheet) throw new Error('Sheet "Overall Summary" not found.');
    if (!wreSheet) throw new Error('Sheet "WRE Mapping" not found.');

    const summary = XLSX.utils.sheet_to_json(summarySheet);
    const wre = XLSX.utils.sheet_to_json(wreSheet);

    console.log(`✅ Successfully fetched live data: ${summary.length} rows`);
    res.json({ summary, wre });
  } catch (err) {
    console.error('API ERROR:', err.response?.data || err.message);
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
