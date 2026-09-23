# Optional accounts, passkeys, and billing

Accounts do not replace guest access. `/account` offers username/password sign-in, password changes, passkeys, preferences, and individual session revocation. No email address is collected by this account implementation, and there is no email password recovery. The page tells users to retain their password in a password manager. Owner-code sign-in remains the recovery path for the owner account.

## Terminal integration

```js
const Accounts = require('./shared/accounts')({
  dataDir: DATA_DIR,
  origin: process.env.ACCOUNT_ORIGIN, // canonical HTTPS origin, never arbitrary request Host
  isSameOrigin,
  clientIp,
});
```

After identifying the board device and applying Board.gate, call:

```js
if (await Accounts.handle(req, res, pathname, {
  role: role(req), secure: isHttps(req), deviceId: who.dev,
})) return;
```

`handle` accepts `/account`, `/account/`, and `/api/account/*`. It reads its own bounded JSON bodies. The signed Stripe webhook route `/api/account/billing/webhook` reads raw bytes and must arrive before generic JSON parsing. Stripe webhook delivery is not authenticated by visitor cookies or CSRF; it is verified with the official SDK signature verifier, including timestamp tolerance.

Expose these same-origin static assets:

- `/_board/accounts.css` → `design/accounts.css`
- `/_board/accounts.js` → `design/accounts.js`
- `/_board/passkeys.js` → `node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js`

Role resolution must recognize `Accounts.identity(req)?.role`, with `owner` assigned exclusively to the server-created owner account. Successful owner-code login may call `Accounts.startOwnerSession(req,res,{role:'owner',secure,deviceId})`, then clear legacy static owner credential cookies. Passkey sign-in never sets legacy permanent owner credentials. Enrollment/sign-in clears root and sport-scoped legacy auth cookies. Account-rendered football HTML strips permanent launch-key bootstrap scripts and uses a credential-free manifest. Cached owner launch URLs cannot authenticate public or revoked sessions; legacy owner-cookie sessions continue to work. Existing legacy owner-code access remains available.

For signed-in sport requests:

1. Replace the forwarded cookie header with `Accounts.forwardCookie(req, sport)`.
2. Inject the correct owner/guest engine access credential **only into the internal request**. Do not send permanent owner credentials to the browser for an account session.
3. Filter upstream cookies through `Accounts.filterEngineCookies(req, pres.headers['set-cookie'])`. Account engine identity cookies must never reach the browser, including on sign-out.
4. Reject the legacy `/api/me/link` and `/api/me/join` endpoints while signed in. Use account sign-in on the second device instead.
5. Stop open account SSE connections when their account session expires or is revoked. Do not retain cached authority for the connection indefinitely.
6. `/logout` calls `Accounts.signOut(req,res,{secure})`. Admin Center block/sign-out calls `Accounts.revokeDevice(boardDeviceId)`.

For guest accounts, sport IDs are random server-owned mappings. Owner accounts deliberately keep the existing per-browser engine identities, so adding a passkey does not hide or move the owner's current tickets. Owner preferences and access sync; the owner's older ticket logs remain device-specific until an explicit verified migration is implemented. Account responses filter permanent owner credential cookies for every account, including owners. Anonymous sport IDs remain in the browser unchanged. Signing out returns the browser to its existing anonymous log. Old anonymous tickets are not silently claimed based on arbitrary posted engine IDs. If import is implemented, the `importLog` callback must validate an engine-issued one-time code and ensure another account does not own the source ID **before** mutating engine tickets. This release can omit the callback; the import UI remains hidden. NHL has no legacy one-time import endpoint.

Preferences are normalized and stored server-side. Signed-in clients can read them from `/api/account/me`; callers save through CSRF-protected `/api/account/preferences`. Engines should consume the account preference record instead of assuming browser storage is the authority.

## Security and operational properties

- Passwords: Node crypto scrypt, N=32768, r=8, p=1, unique salt, 64-byte output.
- Sessions: 256-bit opaque random cookies, only SHA-256 token hashes persisted; 30 days for users and 12 hours for owner; at most 20 sessions per account.
- Mutations: same-origin checks plus a session-bound CSRF token; pre-login tokens are server signed and expire after one hour.
- Passkeys: maintained SimpleWebAuthn verifier, fixed origin and RP, required user verification, expiring one-use challenges bound to browser session. Registration/removal requires recent sign-in.
- Rate limits: IP and username authentication limits, global expensive-operation budget, bounded caches and request bodies.
- Account data: atomic `accounts/accounts.json` writes, mode 0600 in directory mode 0700. Mount a persistent volume and back it up. The module assumes **one terminal writer per volume**; migrate storage to a transactional database before adding replicas.
- Existing engine identity IDs are credentials under legacy engine contracts. Account mappings are never included in public account responses.
- User-entered names and labels are escaped before UI rendering. No account token appears in query strings or localStorage.

## Stripe configuration

Checkout stays disabled until all settings are present:

- `ACCOUNT_ORIGIN`: canonical HTTPS app origin.
- `STRIPE_SECRET_KEY`: secret API key, held only in server environment.
- `STRIPE_PRICE_ID`: ID of the configured recurring Price, `price_...`.
- `STRIPE_WEBHOOK_SECRET`: endpoint signing secret, `whsec_...`.

Create a Stripe webhook for `/api/account/billing/webhook` and subscribe to `customer.subscription.created`, `customer.subscription.updated`, and `customer.subscription.deleted`. Enable Stripe Customer Portal for payment-method changes/cancellation. Start with Stripe test mode before enabling a live price. No product, price, charge, customer or subscription is created by merely deploying unconfigured code.

The server reads amount/currency/interval from its configured Stripe Price. Checkout uses that Price only. Customer creation uses a stable account-bound idempotency key. Existing active/trialing/overdue subscriptions prevent another checkout. Hosted checkout/portal URLs are constrained to Stripe domains. The return URL never grants Pro access.

Only verified lifecycle events update entitlements. The handler fetches canonical subscription state, validates the account/customer/configured price, checks billing-period expiry, records event IDs, ignores older events, and updates canceled/overdue access. Configure monitoring for webhook failures; a signed event retry must succeed before access changes are complete. Free board and personal logs remain available independently of subscription state.

## Validation

`node --test tests/accounts.test.js tests/account-billing.test.js`

Tests exercise password storage, cross-device identity mapping, anonymous preservation, spoofed cookies, CSRF/origin checks, expiry, revocation isolation, password changes, owner bootstrap, rate limits, concurrent username uniqueness, passkey origin/challenge binding, real verifier rejection of forged assertions, restart persistence, signed Stripe lifecycle events, duplicate and out-of-order delivery, wrong prices/customers, and disabled checkout.

Primary implementation references: [SimpleWebAuthn server](https://simplewebauthn.dev/docs/packages/server), [SimpleWebAuthn browser](https://simplewebauthn.dev/docs/packages/browser).

## Launch boundary

A Stripe configuration alone does not establish a paid-feature policy or provider eligibility. Keep live billing disabled until the owner approves the product/price and defines which routes/features require Pro. This release provides entitlement state and subscription lifecycle plumbing; it does not silently paywall the boards or previews. Describe the actual sports-analytics business accurately to Stripe and confirm support before accepting payments. [Stripe business restrictions](https://stripe.com/legal/restricted-businesses).
