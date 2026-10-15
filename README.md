# Groupmail Subscriptions API — Node.js example

A runnable reference integration for the Groupmail Nemo **managed double-opt-in
Subscriptions API**. It shows how an integrator's backend starts a subscription,
how the subscriber confirms (PIN typed into a form, or a link clicked in the
email), and how confirmed contacts land in your Groupmail group(s).

> **Built for:** GRO-61 (Activelink / Annertech Drupal integration). This repo is
> the working example referenced from that ticket.

---

## What this API is for

Adding a contact straight through `POST /contacts` has **no confirmation step** —
anyone could submit an address and that person is subscribed without consent.
That's a GDPR problem and a deliverability risk (spam traps, complaints, bounces).

The Subscriptions API gives you **verifiable, GDPR-compliant double opt-in**:

1. Your form posts an email to **your** backend.
2. Your backend calls Groupmail, which **emails the subscriber** a PIN and/or a
   confirmation link.
3. Only when the subscriber proves they own the inbox (returns the PIN, or clicks
   the link) is the contact created — `active` — in your group(s), or reactivated
   if they had unsubscribed.

**Key invariant:** Groupmail always sends the email, and the **PIN / link token
is never returned to the API caller.** That email is the only channel carrying
the secret — which is exactly what makes the opt-in verifiable. (If you *don't*
want opt-in, use `POST /contacts` instead.)

One attempt can subscribe a person to **1–10 groups** at once: one email, one
PIN/link, one confirmation activates them everywhere.

### What Groupmail handles vs. what you build

| Groupmail handles | You build |
|---|---|
| Sending the confirmation email (PIN + link) | The signup form / subscriber UX |
| Generating & verifying the PIN and link token | The PIN-entry field, the link landing page |
| Abuse safeguards (rate limits, spam, honeypot, brute-force lockout) | Forwarding subscriber signals (IP, honeypot) |
| Creating (or reactivating) the contact(s) on confirm + firing webhooks | Polling/handling the result, your own error UX |

---

## Base URL & authentication

| Environment | Base URL |
|---|---|
| **Production** | `https://developer.groupmail.io` |
| Staging | `https://fusion-api.onrender.com` |

> `https://developer.groupmail.io` is the canonical host (it's the one declared in
> the OpenAPI spec) — integrate against it. The Swagger UI linked from GRO-61,
> `https://developer.groupmail.app/docs`, currently resolves to the same service.

Every request authenticates with your API key in the **`X-API-ID`** header:

```
X-API-ID: nemo_xxxxxxxxxxxxxxxxxxxx
```

- The key is a **server-side secret** — keep it on your backend, never in the
  browser. (The endpoints are CORS-open, but the key is the only credential, so
  treat it like a password.)
- Scopes: **`write`** for start / confirm / resend, **`read`** for status.
- Interactive reference (try-it-out): **`/docs`** (Swagger UI) ·
  spec at **`/openapi.json`**.

You'll also need your **Group IDs** (24-char hex). List them with `GET /groups`
or copy them from the Groupmail dashboard.

---

## The flow

```
Subscriber fills your form
  └─▶ your backend:  POST /subscriptions            (email, groupIds[], method, …)
        └─▶ Groupmail: abuse checks → store attempt → email PIN and/or link
              │
   PIN  ──────┤  subscriber types the PIN into your form
              │   └─▶ your backend: POST /subscriptions/:attemptId/confirm { pin }
              │
   LINK ──────┘  subscriber clicks https://you.example/confirm?token=…
                  └─▶ your backend: POST /subscriptions/confirm { token }

  on confirm → contacts created (active) in every requested group
               (a contact who had unsubscribed is reactivated),
               group events recorded, webhooks fired
```

`method` is `pin`, `link`, or `both`. With `both`, either path confirms the same
attempt.

---

## Endpoint reference

All paths are relative to the base URL. Bodies and responses are JSON.

### 1. Start an attempt — `POST /subscriptions`

Scope `write` · rate cost **5** · supports `Idempotency-Key` (must match
`[A-Za-z0-9_-]`, 1–128 chars; a repeat key within 24h replays the original
attempt instead of sending a second email).

```bash
curl -X POST https://developer.groupmail.io/subscriptions \
  -H "X-API-ID: nemo_..." \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 3f9c-...-form-submit-42" \
  -d '{
    "email": "subscriber@example.com",
    "groupIds": ["6633aa...e1", "6633bb...e2"],
    "method": "both",
    "confirmationUrl": "https://you.example/confirm",
    "firstname": "Ada",
    "lastname": "Lovelace",
    "subscriber": { "ip": "203.0.113.7", "userAgent": "...", "honeypot": "" }
  }'
```

| Field | Required | Notes |
|---|---|---|
| `email` | ✅ | max 254 chars |
| `groupIds` | ✅ | array of 1–10 group ObjectIds; **all** must belong to your account |
| `method` | ✅ | `pin` \| `link` \| `both` |
| `confirmationUrl` | for `link`/`both` | **publicly-resolvable HTTPS URL**, max 2048 chars; the token is appended as `?token=…`. Forbidden for `pin`. localhost / private / reserved IPs are rejected (SSRF protection). |
| `firstname`, `lastname` | – | max 100 |
| `mobile` | – | max 30 |
| `field1`–`field4` | – | max 500 each (custom fields, stored on the contact) |
| `subscriber.ip` | – | **strongly recommended** — enables the per-IP abuse limit |
| `subscriber.userAgent` | – | forwarded end-user signal |
| `subscriber.honeypot` | – | a hidden form field; if non-empty, the attempt is silently dropped |

**`201` response** (the secret is never here):

```json
{
  "attemptId": "6650c1...f4",
  "email": "subscriber@example.com",
  "groupIds": ["6633aa...e1", "6633bb...e2"],
  "method": "both",
  "status": "pending",
  "pinExpiresAt": "2026-06-18T17:25:00.000Z",
  "expiresAt": "2026-06-19T17:10:00.000Z",
  "createdAt": "2026-06-18T17:10:00.000Z",
  "confirmedAt": null,
  "results": null
}
```

Hand `attemptId` to your front-end — it's **not** a secret (the PIN is), and the
PIN-confirm call needs it.

### 2a. Confirm with PIN — `POST /subscriptions/:attemptId/confirm`

Scope `write`. Body `{ "pin": "K7QXM" }` (5 chars, case-insensitive). 5 wrong
guesses **lock** the attempt (`410 ATTEMPT_LOCKED`) until a resend issues a new
PIN, which resets the count. With at most 5 resends, that's at most 30 guesses
per attempt.

### 2b. Confirm with link token — `POST /subscriptions/confirm`

Scope `write`. Body `{ "token": "…" }` — the value from `?token=` on your landing
page. The token alone identifies the attempt (no `attemptId` needed).

**Confirm response (both methods, `200`):**

```json
{
  "attemptId": "6650c1...f4",
  "status": "confirmed",
  "alreadyConfirmed": false,
  "results": [
    { "groupId": "6633aa...e1", "outcome": "subscribed", "contactId": "…" },
    { "groupId": "6633bb...e2", "outcome": "subscribed", "contactId": "…", "contactStatus": "active", "reactivated": true },
    { "groupId": "6633cc...e3", "outcome": "already_subscribed", "contactId": "…", "contactStatus": "bounced" }
  ]
}
```

| `outcome` | Meaning |
|---|---|
| `subscribed` | the contact is now `active` in that group. Usually it was just created. If a contact with that email had **unsubscribed**, it is reactivated instead, and the result carries `reactivated: true` and `contactStatus: "active"`. |
| `already_subscribed` | a contact with that email was already in the group and nothing changed; `contactId` and `contactStatus` are returned. `active` means it already receives mailings. Any other status (`bounced`, `complaint`, or one the list owner set) means it receives no mailings and was **not** reactivated: only an unsubscribe is the subscriber's to undo. |
| `group_not_found` | group was deleted between start and confirm; skipped |

> **Changed 13 Oct 2026 (API v0.30.0):** an `unsubscribed` contact is now
> reactivated on confirm. Before, it came back as `already_subscribed` with
> `contactStatus: "unsubscribed"` and stayed unsubscribed, so someone who
> unsubscribed by mistake couldn't rejoin. No new `outcome` value was added, so
> code that branches on `outcome` keeps working; read `reactivated` if you need to
> tell a rejoin from a new contact. If your integration worked around the old
> behaviour, you can remove the workaround.

Confirming an already-confirmed attempt **replays** the original result
(`alreadyConfirmed: true`, `200`) — retries are safe.

**Only one confirm applies an attempt** (API v0.30.2). A confirm that arrives
while another is applying the same attempt (a double submit, or the PIN and the
link of a `both` attempt at once) waits for it and returns the same results with
`alreadyConfirmed: true`. If the other is still running after a few seconds, it
gets `409 CONFIRMATION_IN_PROGRESS` (`retryAfterSeconds: 1`); retry shortly and
you'll get the replay. Treat it as "not finished yet", not as a failure to show
the subscriber. You also get it if the other confirm failed instead; your retry
then applies the attempt itself.

**If a confirm fails partway** (a `5xx`), retry it with the same PIN or token.
Groups it had already applied come back as `subscribed` again, and their
webhooks fire with the rest when the retry completes. If one of those contacts
was unsubscribed, bounced or removed in between, that change stands: the group
comes back as `already_subscribed` with its `contactStatus`, and no webhook
fires for it. A group the failed confirm found already subscribed comes back as
`already_subscribed` again, with its current `contactStatus`: the retry doesn't
reactivate it, even if the subscriber has unsubscribed since (API v0.30.4). A
retry isn't refused at your contact limit for the contacts the failed confirm
already added. Nothing fires for a confirm that didn't complete.

### 3. Resend — `POST /subscriptions/:attemptId/resend`

Scope `write` · rate cost 5. Issues a **fresh PIN** (new 15-min window, guess
counter reset) and **rotates the link token** (the old link stops working), then
re-sends the email. 60-second cooldown, max 5 resends per attempt.

### 4. Status — `GET /subscriptions/:attemptId`

Scope `read`. Returns the attempt shape with `status` ∈
`pending | confirmed | expired` and, after confirmation, the per-group `results`.
Never returns the PIN or token.

---

## Lifetimes & limits

| Thing | Value |
|---|---|
| PIN validity | **15 minutes** (refreshed on resend) |
| Whole attempt / link token | **24 hours** |
| PIN format | 5 chars, `A–Z2–9` minus look-alikes (`0 O 1 I`), case-insensitive |
| Wrong-PIN lockout | **5** guesses → `ATTEMPT_LOCKED` (guesses sent in parallel count too; guesses at a PIN that a resend has since replaced don't count against the new one). A resend issues a new PIN and resets the count |
| Starts per email, per account | **3 / hour** (counts *new* attempts; resends don't count) |
| Starts per IP, per account | **10 / hour** (only when `subscriber.ip` is sent) |
| Resends per attempt | 5, with a 60s cooldown — bounded independently of the start caps |
| Groups per attempt | 1–10 |

---

## Abuse safeguards (what you should know)

Groupmail mirrors the protections on its own hosted form. Two things matter for
your integration:

1. **Forward `subscriber.ip`** (and a honeypot field). The IP unlocks per-IP rate
   limiting; the honeypot silently drops bots.
2. **There is no "rejected" oracle.** Honeypot hits, spam verdicts (CleanTalk),
   and "already active in every requested group" all return a normal
   `201 pending` and send **no email** — indistinguishable from a real pending
   attempt. Don't build logic that expects a distinct "blocked" signal; just let
   the confirmation flow run. A genuinely blocked attempt simply never confirms.
   A contact who had unsubscribed isn't blocked: they're sent the email, so they
   can confirm and rejoin.

---

## Error codes

Errors are JSON `{ "error": "human message", "code": "MACHINE_CODE" }`. Branch on
`code`, not the message.

| HTTP | `code` | When |
|---|---|---|
| 400 | `INVALID_EMAIL` | email failed the format check |
| 400 | `INVALID_CONFIRMATION_URL` | missing for link/both, present for pin, or not a valid HTTPS URL |
| 400 | `INVALID_PIN` | wrong PIN (remaining count intentionally not disclosed) |
| 400 | `INVALID_IDEMPOTENCY_KEY` | `Idempotency-Key` not 1–128 chars of `[A-Za-z0-9_-]` |
| 404 | `GROUP_NOT_FOUND` | (at **start**) a `groupId` isn't visible to your key — foreign IDs look identical to nonexistent ones |
| 410 | `GROUP_NOT_FOUND` | (on **resend**) none of the attempt's groups still exist / are shared |
| 404 | `ATTEMPT_NOT_FOUND` | unknown `attemptId` |
| 404 | `INVALID_TOKEN` | unknown / expired / foreign link token |
| 410 | `PIN_EXPIRED` | PIN past its 15-min window — resend |
| 410 | `ATTEMPT_LOCKED` | 5 wrong PINs — resend for a new PIN, or start over once the resends are used up |
| 410 | `ATTEMPT_EXPIRED` | attempt past 24h |
| 409 | `ALREADY_CONFIRMED` | resend after confirmation |
| 409 | `CONFIRMATION_IN_PROGRESS` | confirm or resend while another confirm is applying the attempt — retry shortly (`retryAfterSeconds` included); a confirm then gets the replay |
| 429 | `RATE_LIMITED` | hourly email/IP cap, or resend limit |
| 429 | `RESEND_COOLDOWN` | within the 60s resend cooldown (`retryAfterSeconds` included) |
| 403 | `CONTACT_LIMIT_REACHED` | your plan's contact limit (checked at confirm time) |
| 502 | `EMAIL_SEND_FAILED` | the confirmation email couldn't be sent |

**Authentication-layer errors** (raised by the auth middleware before the handler
runs): `401` with no `code` for a missing / invalid / expired key;
`403 API_ACCESS_DENIED` when your plan doesn't include API access (the most common
first-run failure); `403 ACCOUNT_UNDER_REVIEW` when the account is under review.

Standard `X-RateLimit-*` headers apply to the per-key API rate limit (start and
resend cost 5 units each).

---

## Webhooks

If you've configured outbound webhooks, this flow emits:

- `subscription.requested` — on a successful (non-blocked) start.
- `subscription.confirmed` — on confirm; payload includes per-group `results` and
  `contactIds` (reactivated contacts included).
- `contact.created` — once per contact actually created.
- `contact.status_changed` — once per contact reactivated
  (`previousStatus: "unsubscribed"`, `status: "active"`,
  `source: "api_subscription"`).

A confirm's events (`contact.created`, `contact.status_changed` and
`subscription.confirmed`) are saved with the confirmation and published from
there, so a restart or an outage on Groupmail's side can delay them but not lose
them (API v0.31.0). Now and then one may arrive twice. Each carries a fixed
`id`, the same on every delivery, so de-duplicate on the payload's `id`. Its
`timestamp` is when the confirm happened.

---

## Running this example

```bash
npm install
cp .env.example .env      # then fill in GROUPMAIL_API_KEY + GROUPMAIL_GROUP_IDS
```

**Web app** (signup form + PIN + link landing):

```bash
npm start                 # http://localhost:3000
```

- The **PIN flow** works out of the box locally.
- The **link flow** needs a public **HTTPS** `CONFIRM_BASE_URL` (the API rejects
  non-HTTPS confirmation URLs). For local testing, expose the app with a tunnel
  (e.g. `ngrok http 3000`) and set `CONFIRM_BASE_URL` to the https URL.

**CLI smoke test** (full PIN cycle against the live API):

```bash
npm run smoke             # sends a real email to TEST_EMAIL, asks you to paste the PIN
```

### Files

| File | What it shows |
|---|---|
| `lib/groupmailClient.js` | A reusable client wrapping all five endpoints — **the part to copy into your own app.** |
| `server.js` | Express backend: proxies the form to Groupmail, keeping the API key server-side. |
| `public/index.html` | Signup form, PIN entry, resend, honeypot, group selection. |
| `public/confirm.html` | The link landing page — reads `?token=` and confirms. |
| `scripts/smoke.js` | Operator-run end-to-end check of the PIN cycle. |

> **Security notes baked into this example:** the API key lives only on the
> backend; the front-end renders all dynamic text via `textContent` (never
> `innerHTML`); `req.ip` and a honeypot field are forwarded to Groupmail; and the
> server passes the API's `code` straight through so the UI can react to
> `INVALID_PIN`, `RATE_LIMITED`, etc.
>
> **⚠ `subscriber.ip` / `trust proxy`:** Groupmail's per-IP cap is only as
> trustworthy as the IP you send. Express derives `req.ip` from `X-Forwarded-For`,
> which a client can forge unless a proxy you control overwrites it. Set
> `TRUST_PROXY` to the number of proxy hops in front of this app (e.g. `1` behind
> one load balancer) — **never `true` on a directly internet-exposed app**, or the
> per-IP limit becomes spoofable. The default (`false`) uses the raw socket
> address, which is correct for local testing.
