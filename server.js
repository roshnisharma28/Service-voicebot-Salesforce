const express = require('express');
const axios = require('axios');
require('dotenv').config();
const app = express();

app.use(express.json());

// Salesforce config from env
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
    const response = await axios.post(
      SALESFORCE_CONFIG.tokenUrl,
      new URLSearchParams({
        grant_type: 'password',
        client_id: SALESFORCE_CONFIG.clientId,
        client_secret: SALESFORCE_CONFIG.clientSecret,
        username: SALESFORCE_CONFIG.username,
        password: SALESFORCE_CONFIG.password
      })
    );

    accessToken = response.data.access_token;
    console.log('✅ Salesforce token obtained');
    return response.data;
  } catch (error) {
    console.error('❌ Auth error:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Robust issue/subject extractor:
 * - Prefer explicit vapiData.issue if present
 * - Otherwise mine transcript for common patterns
 * - Fall back to concise phrase extraction
 * - Final clamp for clean Case.Subject / Phone_Call__c.Name
 */
function extractIssue(vapiData) {
  // 1) Prefer explicit issue field if tool sends it
  const explicit =
    vapiData && typeof vapiData.issue === 'string'
      ? vapiData.issue.trim()
      : '';
  if (explicit) return clampSubject(explicit);

  // 2) Use transcript (string or nested)
  const transcript =
    typeof vapiData?.transcript === 'string'
      ? vapiData.transcript
      : typeof vapiData?.transcript?.text === 'string'
      ? vapiData.transcript.text
      : '';

  const text = (transcript || '').replace(/\s+/g, ' ').trim();
  if (!text) return 'Support request';

  // 3) Pattern-based candidates
  const candidates = [];
  const patterns = [
    /\bissue\s*(?:is|:)\s*([^.!?\n\r]+)/i,
    /\bproblem\s*(?:is|:)\s*([^.!?\n\r]+)/i,
    /\berror\s*(?:is|:)\s*([^.!?\n\r]+)/i,
    /\bgetting\s+(?:an?\s+)?error\s*([^.!?\n\r]*)/i,
    /\bi\s*can(?:\'t|not)\s+([^.!?\n\r]+)/i,
    /\bunable\s+to\s+([^.!?\n\r]+)/i,
    /\bi\s*am\s*facing\s+([^.!?\n\r]+)/i,
    /\bi\s*am\s*having\s+([^.!?\n\r]+)/i,
    /\bi\s*have\s+([^.!?\n\r]+)/i,
    /\bthere\s+is\s+([^.!?\n\r]+)/i,
    /\b((?:low|high|poor|slow|failed|failing|broken|missing|invalid|expired)\s+[a-z][a-z\s]{2,})\b/i
  ];

  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const captured = (m[m.length - 1] || '').trim();
      if (captured) candidates.push(captured);
    }
  }

  if (candidates.length) {
    const best = pickBestCandidate(candidates);
    return clampSubject(best);
  }

  // 4) Fallback concise noun-phrase extraction
  const fallback = conciseSubjectFromSentence(text);
  if (fallback) return clampSubject(fallback);

  // 5) Minimal neutral
  return 'Support request';
}

// Keep subject short, single-line, safe for SFDC Subject/Name fields
function clampSubject(s) {
  return s
    .replace(/["'`]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[,:;\-\s]+|[,:;\-\s]+$/g, '')
    .slice(0, 120)
    .trim();
}

// Choose the best candidate via simple heuristics
function pickBestCandidate(arr) {
  const keywords = [
    'login',
    'power',
    'generation',
    'payment',
    'otp',
    'reset',
    'error',
    'timeout',
    'latency',
    'crash',
    'fail',
    'unable',
    'cannot',
    'blocked',
    'verification',
    'invoice',
    'delivery'
  ];
  const scored = arr.map((s) => {
    const ls = s.toLowerCase();
    const hits = keywords.reduce((acc, k) => acc + (ls.includes(k) ? 1 : 0), 0);
    const lenPenalty = Math.max(0, Math.ceil((ls.length - 80) / 20));
    return { s, score: hits - lenPenalty };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].s;
}

// Lightweight noun-phrase fallback
function conciseSubjectFromSentence(text) {
  let t = text
    .replace(/^(hi|hello|hey|good\s+(morning|evening|afternoon))[,!\s]*/i, '')
    .replace(/\bi\s*(am|m|have|had|was|were)\b/gi, '')
    .replace(/\b(please|kindly|help|assist)\b/gi, '')
    .trim();

  const cues = ['about', 'regarding', 'related to', 'facing', 'having', 'with', 'on'];
  for (const c of cues) {
    const idx = t.toLowerCase().indexOf(c + ' ');
    if (idx !== -1) {
      t = t.slice(idx + c.length + 1).trim();
      break;
    }
  }

  t = t.replace(/\b(thank you|thanks|please|can you|could you|help me).*/i, '').trim();

  const m = t.match(/^([^.!?\n\r]{3,120})/);
  return m ? m[1].trim() : '';
}

// Main webhook endpoint
app.post('/vapi-webhook', async (req, res) => {
  try {
    console.log('📞 Received webhook');

    // Only process end-of-call reports (or accept tool posts that mimic it)
    if (req.body.type && req.body.type !== 'end-of-call-report') {
      return res.json({ success: true });
    }

    // Ensure token
    if (!accessToken) {
      await getSalesforceToken();
    }

    // Extract issue/subject
    const issue = extractIssue(req.body);
    console.log('📝 Subject:', issue);

    // 1) Create Case with Subject
    const caseResponse = await axios.post(
      `${SALESFORCE_CONFIG.instanceUrl}/services/data/v58.0/sobjects/Case/`,
      { Subject: issue },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    // 2) Create Phone Call with Name
    const phoneCallResponse = await axios.post(
      `${SALESFORCE_CONFIG.instanceUrl}/services/data/v58.0/sobjects/Phone_Call__c/`,
      { Name: issue },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
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
