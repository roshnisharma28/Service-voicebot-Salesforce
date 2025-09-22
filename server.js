const express = require('express');
const axios = require('axios');
require('dotenv').config(); // Add this line to load .env file
const app = express();

app.use(express.json());

// ✅ SECURE - Uses environment variables
const SALESFORCE_CONFIG = {
  clientId: process.env.SALESFORCE_CLIENT_ID,
  clientSecret: process.env.SALESFORCE_CLIENT_SECRET,
  username: process.env.SALESFORCE_USERNAME,
  password: process.env.SALESFORCE_PASSWORD,
  tokenUrl: 'https://test.salesforce.com/services/oauth2/token',
  instanceUrl: process.env.SALESFORCE_INSTANCE_URL
};

let accessToken = null;

// Get Salesforce access token
async function getSalesforceToken() {
  try {
    const response = await axios.post(SALESFORCE_CONFIG.tokenUrl, new URLSearchParams({
      grant_type: 'password',
      client_id: SALESFORCE_CONFIG.clientId,
      client_secret: SALESFORCE_CONFIG.clientSecret,
      username: SALESFORCE_CONFIG.username,
      password: SALESFORCE_CONFIG.password
    }));
    
    accessToken = response.data.access_token;
    console.log('✅ Salesforce token obtained');
    return response.data;
  } catch (error) {
    console.error('❌ Auth error:', error.response?.data || error.message);
    throw error;
  }
}

// Extract issue from Vapi transcript
function extractIssue(vapiData) {
  const transcript = vapiData.transcript || '';
  
  const issueMatch = transcript.match(/issue.*?is.*?([^.!?]*)/i) ||
                    transcript.match(/problem.*?is.*?([^.!?]*)/i) ||
                    transcript.match(/can't.*?([^.!?]*)/i);
  
  return issueMatch ? issueMatch[1].trim() : 'Customer support request';
}

// Main webhook endpoint
app.post('/vapi-webhook', async (req, res) => {
  try {
    console.log('📞 Received webhook');
    
    // Only process end-of-call reports
    if (req.body.type !== 'end-of-call-report') {
      return res.json({ success: true });
    }
    
    // Get token if needed
    if (!accessToken) {
      await getSalesforceToken();
    }
    
    // Extract issue
    const issue = extractIssue(req.body);
    console.log('📝 Issue:', issue);
    
    // 1. Create Case - ONLY Subject field
    const caseResponse = await axios.post(
      `${SALESFORCE_CONFIG.instanceUrl}/services/data/v58.0/sobjects/Case/`,
      {
        Subject: issue  // ← Issue goes to Subject field
      },
      { headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    
    // 2. Create Phone Call - ONLY Name field  
    const phoneCallResponse = await axios.post(
      `${SALESFORCE_CONFIG.instanceUrl}/services/data/v58.0/sobjects/Phone_Call__c/`,
      {
        Name: issue     // ← Issue goes to Name field
      },
      { headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    
    console.log(`✅ Case: ${caseResponse.data.id}`);
    console.log(`✅ Phone Call: ${phoneCallResponse.data.id}`);
    
    res.json({
      success: true,
      caseId: caseResponse.data.id,
      phoneCallId: phoneCallResponse.data.id
    });
    
  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'Running' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  getSalesforceToken().catch(console.error);
});
