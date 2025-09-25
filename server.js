const express = require('express');
const axios = require('axios');
const app = express();
 
app.use(express.json());
 
// ⚠️ UPDATE THESE WITH YOUR ACTUAL VALUES
const SALESFORCE_CONFIG = {
  clientId: '3MVG9zV9CSFNbVbM4B6RB6otu_YPDrPdJzVkzDmK9i7m.5Xz3iIcVbQvHIng_YWJiQ9x_eJNcER8YLGxfrWfp',
  clientSecret: 'C01AA6D513645CB0D9B4541D21114436C4ED27320BC68A29FF2D43E5D4A3B17F',
  username: 'zoximaadmin@zoxima.com.services',
  password: 'Zoxima@2018rSrWaqmuSUHaewd3b7HuTSR7',
  tokenUrl: 'https://test.salesforce.com/services/oauth2/token',
  instanceUrl: 'https://d1u0000013cp9uae--services.sandbox.my.salesforce.com'
};
 
let accessToken = null;
 
// --- Get Salesforce access token ---
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
 
// --- Helper: Find Account by Phone ---
async function findAccountByPhone(phoneNumber) {
  const query = `SELECT Id, Name, AccountNumber FROM Account WHERE Phone = '${phoneNumber}' LIMIT 1`;
  const response = await axios.get(
    `${SALESFORCE_CONFIG.instanceUrl}/services/data/v58.0/query?q=${encodeURIComponent(query)}`,
    { headers: { 'Authorization': `Bearer ${accessToken}` } }
  );
  return response.data.records[0] || null;
}
 
// --- Helper: Create Phone Call ---
async function createPhoneCall(accountId, data) {
  const payload = {
    Account__c: accountId,
    Name: data.subject || 'Phone Call',
    Description__c: data.description || '',
    Service_Call_Type__c: data.serviceCallType || '',
    Issue_Category__c: data.issueCategory || '',
    Call_Status__c: 'Open'
  };
 
  const response = await axios.post(
    `${SALESFORCE_CONFIG.instanceUrl}/services/data/v58.0/sobjects/Phone_Call__c/`,
    payload,
    { headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
  );
 
  return response.data.id;
}
 
// --- Helper: Update Phone Call Status ---
async function updatePhoneCallStatus(phoneCallId, status) {
  await axios.patch(
    `${SALESFORCE_CONFIG.instanceUrl}/services/data/v58.0/sobjects/Phone_Call__c/${phoneCallId}`,
    { Call_Status__c: status },
    { headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
  );
}
 
// --- Helper: Create Case ---
async function createCase(accountId, phoneCallId, data) {
  const payload = {
    AccountId: accountId,
    Phone_Call__c: phoneCallId,
    Subject: data.subject || 'Customer Issue',
    Description: data.description || '',
    Service_Call_Type__c: data.serviceCallType || '',
    Issue_Category__c: data.issueCategory || '',
    Status: 'New',
    Origin: 'Phone'
  };
 
  const response = await axios.post(
    `${SALESFORCE_CONFIG.instanceUrl}/services/data/v58.0/sobjects/Case/`,
    payload,
    { headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
  );
 
  return response.data.id;
}
 
// --- Helper: Create Service Activity ---
async function createServiceActivity(accountId, caseId, phoneCallId, preferredDatetime, data) {
  const payload = {
    Customer_Name__c: accountId,
    Case__c: caseId,
    Subject__c: data.subject || 'Service Activity',
    Start_Time__c: preferredDatetime,
    Status__c: 'Scheduled',
    Service_Call_Type__c: data.serviceCallType || '',
    Machine_Installed__c: data.machineId || null,
    Phone_Call__c: phoneCallId
  };
 
  const response = await axios.post(
    `${SALESFORCE_CONFIG.instanceUrl}/services/data/v58.0/sobjects/Service_Activity__c/`,
    payload,
    { headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
  );
 
  return response.data.id;
}
 
// --- Main Webhook ---
app.post('/vapi-webhook', async (req, res) => {
  try {
    console.log('📞 Received webhook');
    if (req.body.type !== 'end-of-call-report') {
      return res.json({ success: true });
    }
 
    if (!accessToken) {
      await getSalesforceToken();
    }
 
    const {
      phoneNumber, subject, description, serviceCallType,
      issueCategory, resolutionStatus, createServiceActivity,
      preferredDatetime, machineId
    } = req.body;
 
    // Step 1: Find Account by phone
    const account = await findAccountByPhone(phoneNumber);
    if (!account) {
      return res.status(404).json({ success: false, message: 'Account not found' });
    }
 
    // Step 2: Create Phone Call
    const phoneCallId = await createPhoneCall(account.Id, { subject, description, serviceCallType, issueCategory });
 
    // Step 3: Troubleshoot resolution
    if (resolutionStatus === 'resolved') {
      await updatePhoneCallStatus(phoneCallId, 'Resolved');
      return res.json({ success: true, phoneCallId, message: 'Issue resolved, call closed' });
    }
 
    // Step 4: If not resolved, create Case
    const caseId = await createCase(account.Id, phoneCallId, { subject, description, serviceCallType, issueCategory });
 
    // Step 5: Optional Service Activity
    let serviceActivityId = null;
    if (createServiceActivity === true && preferredDatetime) {
      serviceActivityId = await createServiceActivity(account.Id, caseId, phoneCallId, preferredDatetime, { subject, serviceCallType, machineId });
    }
 
    res.json({ success: true, phoneCallId, caseId, serviceActivityId });
  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});
 
// Health check
app.get('/health', (req, res) => res.json({ status: 'Running' }));
 
// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  getSalesforceToken().catch(console.error);
});
 
