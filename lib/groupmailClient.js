// ─────────────────────────────────────────────────────────────────────────────
// Groupmail Nemo — Subscriptions API client
//
// A thin, dependency-free wrapper over the five managed double-opt-in endpoints.
// Uses the global `fetch` (Node 18+).
//
// SECURITY: the API key authenticates as your account via the `X-API-ID` header.
// It is a server-side secret. Construct this client only on your backend and
// never forward the key (or the PIN / link token) to the browser.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = 'https://developer.groupmail.io';

/**
 * Thrown for any non-2xx API response. `code` is the API's machine-readable
 * error code (e.g. `INVALID_PIN`, `RATE_LIMITED`); branch on it, not on the
 * human-readable `message`.
 */
export class GroupmailError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.name = 'GroupmailError';
    this.status = status; // HTTP status
    this.code = code;     // machine-readable code from the response body
    this.body = body;     // full parsed error body
  }
}

export class GroupmailClient {
  constructor({ apiKey, baseUrl = DEFAULT_BASE_URL } = {}) {
    if (!apiKey) throw new Error('GroupmailClient: `apiKey` is required');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async #request(method, path, { body, idempotencyKey } = {}) {
    const headers = { 'X-API-ID': this.apiKey };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    // Idempotency-Key makes a retried `startSubscription` return the original
    // attempt instead of starting (and emailing) a second one.
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    const data = text ? JSON.parse(text) : null; // the API always replies JSON

    if (!res.ok) {
      throw new GroupmailError(data?.error || `HTTP ${res.status}`, {
        status: res.status,
        code: data?.code,
        body: data,
      });
    }
    return data;
  }

  /**
   * POST /subscriptions — start a double-opt-in attempt.
   *
   * Groupmail emails the subscriber a PIN and/or a confirmation link. The
   * secret is NEVER returned here — the response only carries the `attemptId`
   * (safe to hand to the browser so it can submit the PIN) and timing info.
   *
   * @param {object} input
   * @param {string}   input.email
   * @param {string[]} input.groupIds            1–10 group ObjectIds
   * @param {'pin'|'link'|'both'} input.method
   * @param {string}  [input.confirmationUrl]    required for link/both; HTTPS; `?token=` is appended
   * @param {string}  [input.firstname]
   * @param {string}  [input.lastname]
   * @param {string}  [input.mobile]
   * @param {string}  [input.field1] .. [input.field4]
   * @param {object}  [input.subscriber]         { ip, userAgent, honeypot } — forward these
   * @param {object}  [opts]
   * @param {string}  [opts.idempotencyKey]
   */
  startSubscription(input, { idempotencyKey } = {}) {
    return this.#request('POST', '/subscriptions', { body: input, idempotencyKey });
  }

  /**
   * POST /subscriptions/:attemptId/confirm — confirm with the 5-character PIN
   * the subscriber received by email and typed into your form.
   * 5 wrong guesses permanently lock the attempt (410 ATTEMPT_LOCKED).
   */
  confirmWithPin(attemptId, pin) {
    return this.#request('POST', `/subscriptions/${attemptId}/confirm`, { body: { pin } });
  }

  /**
   * POST /subscriptions/confirm — confirm with the token from the email link.
   * The token alone identifies the attempt, so no attemptId is needed. Read it
   * from `?token=...` on your confirmation landing page.
   */
  confirmWithToken(token) {
    return this.#request('POST', '/subscriptions/confirm', { body: { token } });
  }

  /**
   * POST /subscriptions/:attemptId/resend — re-send the confirmation email.
   * Issues a fresh PIN and rotates the link token (the previous link stops
   * working). 60s cooldown, max 5 resends per attempt.
   */
  resend(attemptId) {
    return this.#request('POST', `/subscriptions/${attemptId}/resend`);
  }

  /**
   * GET /subscriptions/:attemptId — poll attempt status
   * (`pending` | `confirmed` | `expired`). Never returns the PIN or token.
   */
  getStatus(attemptId) {
    return this.#request('GET', `/subscriptions/${attemptId}`);
  }
}
