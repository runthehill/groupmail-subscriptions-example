// ─────────────────────────────────────────────────────────────────────────────
// End-to-end smoke test against the LIVE Groupmail Subscriptions API.
//
// Walks the full PIN cycle:  start  →  poll status  →  (you paste the PIN)  →
// confirm  →  poll status again. Uses the `pin` method so it needs no public
// HTTPS confirmation URL.
//
//   ⚠  This sends a REAL confirmation email to TEST_EMAIL and (on confirm)
//      creates a REAL contact in the configured group(s). Use an address and a
//      throwaway/test group you control.
//
// Run:  npm run smoke
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { GroupmailClient, GroupmailError } from '../lib/groupmailClient.js';

const {
  GROUPMAIL_API_KEY,
  GROUPMAIL_BASE_URL = 'https://developer.groupmail.io',
  GROUPMAIL_GROUP_IDS = '',
  TEST_EMAIL,
} = process.env;

const groupIds = GROUPMAIL_GROUP_IDS.split(',').map((s) => s.trim()).filter(Boolean);

function requireEnv() {
  const missing = [];
  if (!GROUPMAIL_API_KEY) missing.push('GROUPMAIL_API_KEY');
  if (!groupIds.length) missing.push('GROUPMAIL_GROUP_IDS');
  if (!TEST_EMAIL) missing.push('TEST_EMAIL');
  if (missing.length) {
    console.error('Missing required env: ' + missing.join(', ') + ' (see .env.example)');
    process.exit(1);
  }
}

async function main() {
  requireEnv();
  const client = new GroupmailClient({ apiKey: GROUPMAIL_API_KEY, baseUrl: GROUPMAIL_BASE_URL });
  const rl = readline.createInterface({ input, output });

  console.log(`\nStarting PIN subscription for ${TEST_EMAIL} → ${groupIds.length} group(s)…`);
  const attempt = await client.startSubscription({
    email: TEST_EMAIL,
    groupIds,
    method: 'pin',
    firstname: 'Smoke',
    lastname: 'Test',
  });
  console.log('  attemptId:', attempt.attemptId);
  console.log('  status   :', attempt.status, '| pin expires:', attempt.pinExpiresAt);

  const before = await client.getStatus(attempt.attemptId);
  console.log('  poll     :', before.status);

  console.log('\n📧 Check the inbox for', TEST_EMAIL, 'and copy the 5-character PIN.');
  const pin = (await rl.question('Enter PIN: ')).trim();

  try {
    const result = await client.confirmWithPin(attempt.attemptId, pin);
    console.log('\n✅ Confirmed:', JSON.stringify(result.results, null, 2));
  } catch (err) {
    if (err instanceof GroupmailError) {
      console.error(`\n❌ Confirm failed [${err.status} ${err.code}]: ${err.message}`);
    } else {
      throw err;
    }
  } finally {
    const after = await client.getStatus(attempt.attemptId);
    console.log('Final status:', after.status);
    rl.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
