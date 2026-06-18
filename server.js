// ─────────────────────────────────────────────────────────────────────────────
// Example integration server for the Groupmail Subscriptions API.
//
// The endpoint is server-side only: the browser talks to THIS backend, and this
// backend adds the secret API key and proxies to Groupmail. The browser never
// sees the API key, the PIN, or the link token.
//
//   Browser  ──form──▶  this server  ──X-API-ID──▶  Groupmail Subscriptions API
//
// Subscriber-facing UX (the form, the PIN box, the confirmation page) is yours
// to build — this is one minimal reference implementation.
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GroupmailClient, GroupmailError } from './lib/groupmailClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  GROUPMAIL_API_KEY,
  GROUPMAIL_BASE_URL = 'https://developer.groupmail.io',
  GROUPMAIL_GROUP_IDS = '',
  CONFIRM_BASE_URL = '',
  TRUST_PROXY = 'false',
  PORT = 3000,
} = process.env;

// `trust proxy` decides where Express reads the client IP from. We forward that
// IP to Groupmail as `subscriber.ip`, which powers the per-IP abuse cap — so it
// must be a value you actually control, not a client-forgeable X-Forwarded-For.
//   - false (default): use the raw socket address — correct when directly
//     exposed or local. Safe, never spoofable.
//   - a number (e.g. 1): trust exactly N proxy hops in front of this app.
//   ⚠ Do NOT use `true` on a directly internet-exposed app: it trusts a
//     client-supplied XFF and lets attackers forge subscriber.ip.
const parseTrustProxy = (v) =>
  v === 'true' ? true : v === 'false' ? false : Number.isNaN(Number(v)) ? v : Number(v);

if (!GROUPMAIL_API_KEY) {
  console.error('Missing GROUPMAIL_API_KEY — copy .env.example to .env and fill it in.');
  process.exit(1);
}

const GROUP_IDS = GROUPMAIL_GROUP_IDS.split(',').map((s) => s.trim()).filter(Boolean);
const client = new GroupmailClient({ apiKey: GROUPMAIL_API_KEY, baseUrl: GROUPMAIL_BASE_URL });

const app = express();
app.set('trust proxy', parseTrustProxy(TRUST_PROXY));
app.use(express.json());

// The email link lands here: https://<CONFIRM_BASE_URL>/confirm?token=...
app.get('/confirm', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'confirm.html')));
app.use(express.static(path.join(__dirname, 'public')));

// Non-secret config for the front-end (group IDs to subscribe to, whether the
// link flow is wired up). The API key is deliberately NOT exposed here.
app.get('/api/config', (_req, res) => {
  res.json({ groupIds: GROUP_IDS, linkFlowEnabled: Boolean(CONFIRM_BASE_URL) });
});

// 1) Start the double-opt-in. The form posts here; we add the key + subscriber
//    signals and call Groupmail. Groupmail sends the email; we get back an
//    attemptId (not a secret) to hand back to the browser for the PIN step.
app.post('/api/subscribe', async (req, res) => {
  const { email, firstname, lastname, method = 'both', groupIds, website } = req.body ?? {};
  const wantsLink = method === 'link' || method === 'both';
  try {
    const attempt = await client.startSubscription({
      email,
      groupIds: Array.isArray(groupIds) && groupIds.length ? groupIds : GROUP_IDS,
      method,
      // confirmationUrl is required for link/both and must be HTTPS.
      ...(wantsLink && CONFIRM_BASE_URL ? { confirmationUrl: `${CONFIRM_BASE_URL}/confirm` } : {}),
      firstname: firstname || undefined,
      lastname: lastname || undefined,
      subscriber: {
        ip: req.ip,
        userAgent: req.get('user-agent') || undefined,
        honeypot: website || undefined, // hidden field — only bots fill it in
      },
    });
    res.json({ attemptId: attempt.attemptId, method: attempt.method, status: attempt.status });
  } catch (err) {
    sendError(res, err);
  }
});

// 2a) PIN flow — the subscriber types the PIN from the email into your form.
app.post('/api/confirm-pin', async (req, res) => {
  const { attemptId, pin } = req.body ?? {};
  try {
    res.json(await client.confirmWithPin(attemptId, pin));
  } catch (err) {
    sendError(res, err);
  }
});

// 2b) Link flow — your /confirm page reads ?token= and posts it here.
app.post('/api/confirm-token', async (req, res) => {
  const { token } = req.body ?? {};
  try {
    res.json(await client.confirmWithToken(token));
  } catch (err) {
    sendError(res, err);
  }
});

// Resend the confirmation email (fresh PIN, rotated link).
app.post('/api/resend', async (req, res) => {
  try {
    res.json(await client.resend(req.body?.attemptId));
  } catch (err) {
    sendError(res, err);
  }
});

// Poll attempt status.
app.get('/api/status/:attemptId', async (req, res) => {
  try {
    res.json(await client.getStatus(req.params.attemptId));
  } catch (err) {
    sendError(res, err);
  }
});

// Forward the API's HTTP status + machine code to our own front-end unchanged,
// so the browser can branch on `code` (INVALID_PIN, RATE_LIMITED, …).
function sendError(res, err) {
  if (err instanceof GroupmailError) {
    return res.status(err.status || 502).json({ error: err.message, code: err.code });
  }
  console.error(err);
  res.status(500).json({ error: 'Unexpected error' });
}

app.listen(PORT, () => {
  console.log(`Subscriptions example: http://localhost:${PORT}`);
  if (GROUP_IDS.length === 0) {
    console.warn('⚠  No GROUPMAIL_GROUP_IDS set — the form has no groups to subscribe to.');
  }
  if (!CONFIRM_BASE_URL) {
    console.warn('⚠  No CONFIRM_BASE_URL set — the link flow is disabled; use the PIN flow.');
  }
});
