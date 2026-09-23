'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const Stripe = require('stripe');
const createBilling = require('../shared/account-billing');
const signed = new Stripe('sk_test_fixture');
const secret = 'whsec_local_test_fixture';
function fixture() {
  let updates = 0, checkoutArgs, portalArgs;
  const account = { id: 'alice', owner: false, entitlement: { tier: 'free' } };
  let canonical = { id: 'sub_123', customer: 'cus_123', metadata: { accountId: 'alice' }, status: 'active', items: { data: [{ price: { id: 'price_123' }, current_period_end: Math.floor(Date.now() / 1000) + 3600 }] } };
  const stripe = { webhooks: signed.webhooks, customers: { async create() { return { id: 'cus_123' }; } }, subscriptions: { async list() { return { data: [] }; }, async retrieve() { return structuredClone(canonical); } }, prices: { async retrieve() { return { active: true, type: 'recurring', recurring: { interval: 'month', interval_count: 1 }, currency: 'usd', unit_amount: 4900 }; } }, checkout: { sessions: { async create(params) { checkoutArgs = params; return { url: 'https://checkout.stripe.com/c/pay/test' }; } } }, billingPortal: { sessions: { async create(params) { portalArgs = params; return { url: 'https://billing.stripe.com/p/session/test' }; } } } };
  const billing = createBilling({ origin: 'https://board.example', env: { STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_PRICE_ID: 'price_123', STRIPE_WEBHOOK_SECRET: secret }, stripe, getAccount: id => id === 'alice' ? account : null, updateAccount(id, values) { Object.assign(account, values); updates++; } });
  function request(event, valid = true) { const payload = JSON.stringify(event), req = Readable.from([Buffer.from(payload)]); req.headers = { 'stripe-signature': valid ? signed.webhooks.generateTestHeaderString({ payload, secret }) : 'invalid' }; return req; }
  function event(id = 'evt_1', created = 100, type = 'customer.subscription.updated') { return { id, created, type, data: { object: structuredClone(canonical) } }; }
  return { billing, account, request, event, get updates() { return updates; }, get checkoutArgs() { return checkoutArgs; }, get portalArgs() { return portalArgs; }, set canonical(value) { canonical = value; }, get canonical() { return canonical; } };
}
test('billing is disabled unless canonical HTTPS origin and all three credentials are configured', () => {
  for (const env of [{}, { STRIPE_SECRET_KEY: 'sk_test_x' }, { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_ID: 'price_x' }]) assert.equal(createBilling({ env, origin: 'https://board.example' }).configuration().enabled, false);
  assert.equal(createBilling({ env: { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_ID: 'price_x', STRIPE_WEBHOOK_SECRET: secret }, origin: 'http://localhost' }).configuration().enabled, false);
});
test('configured checkout uses only server price and binds subscription metadata to authenticated account', async () => {
  const f = fixture(); await f.billing.checkout(f.account);
  assert.deepEqual(f.checkoutArgs.line_items, [{ price: 'price_123', quantity: 1 }]); assert.equal(f.checkoutArgs.client_reference_id, 'alice'); assert.equal(f.checkoutArgs.subscription_data.metadata.accountId, 'alice');
  assert.equal(f.account.entitlement.tier, 'free'); assert.equal(f.updates, 1); assert.equal(f.account.billing.customerId, 'cus_123'); assert.equal((await f.billing.pricing()).amount, 4900);
});
test('invalid signature never grants access', async () => { const f = fixture(); await assert.rejects(f.billing.webhook(f.request(f.event(), false)), /signature/); assert.equal(f.updates, 0); });
test('signed lifecycle event grants access, duplicate is idempotent and late delivery cannot roll back state', async () => {
  const f = fixture(), first = f.event(); await f.billing.webhook(f.request(first)); assert.equal(f.account.entitlement.tier, 'pro'); assert.equal(f.updates, 1);
  assert.equal((await f.billing.webhook(f.request(first))).duplicate, true); assert.equal(f.updates, 1);
  f.canonical.status = 'canceled'; await f.billing.webhook(f.request(f.event('evt_2', 200, 'customer.subscription.deleted'))); assert.equal(f.account.entitlement.tier, 'free'); assert.equal(f.updates, 2);
  assert.equal((await f.billing.webhook(f.request(f.event('evt_old', 150)))).ignored, true); assert.equal(f.account.entitlement.tier, 'free');
});
test('checkout completion or browser success is never entitlement evidence', async () => {
  const f = fixture(); await f.billing.webhook(f.request(f.event('evt_success', 100, 'checkout.session.completed'))); assert.equal(f.updates, 0); assert.equal(f.account.entitlement.tier, 'free');
});
test('unknown price, overdue subscription or expired period cannot grant Pro', async () => {
  for (const kind of ['price', 'status', 'expiry']) { const f = fixture(); if (kind === 'price') f.canonical.items.data[0].price.id = 'price_wrong'; if (kind === 'status') f.canonical.status = 'past_due'; if (kind === 'expiry') f.canonical.items.data[0].current_period_end = 1; await f.billing.webhook(f.request(f.event())); assert.equal(f.account.entitlement.tier, 'free'); }
});
test('mismatched customer cannot change account entitlement; portal uses stored authenticated customer', async () => {
  const f = fixture(); f.account.billing = { customerId: 'cus_other' }; await assert.rejects(f.billing.webhook(f.request(f.event())), /does not match/); assert.equal(f.updates, 0);
  await f.billing.portal(f.account); assert.equal(f.portalArgs.customer, 'cus_other'); assert.equal(f.portalArgs.return_url, 'https://board.example/account');
});
test('canonical provider reread prevents stale event payload from reactivating canceled subscription', async () => {
  const f = fixture(), stale = f.event(); f.canonical.status = 'canceled'; await f.billing.webhook(f.request(stale)); assert.equal(f.account.entitlement.tier, 'free');
});
