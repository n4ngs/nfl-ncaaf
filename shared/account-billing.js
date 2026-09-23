'use strict';
// Hosted Stripe billing. Redirects never grant access; signed subscription events do.
const fail = (message, status = 400) => { const e = new Error(message); e.status = status; throw e; };
module.exports = function createBilling(options) {
  const env = options.env || process.env;
  const secret = env.STRIPE_SECRET_KEY || '', priceId = env.STRIPE_PRICE_ID || '', webhookSecret = env.STRIPE_WEBHOOK_SECRET || '';
  const origin = options.origin;
  const enabled = !!(secret && /^price_[A-Za-z0-9]+$/.test(priceId) && webhookSecret && origin?.startsWith('https://'));
  const client = () => options.stripe || new (require('stripe'))(secret, { maxNetworkRetries: 1, timeout: 12000 });
  let stripe, priceCache;
  const getStripe = () => stripe ||= client();
  const configuration = () => ({ enabled, message: enabled ? 'Secure checkout is available.' : 'Pro checkout is not available yet.' });
  async function pricing() {
    if (!enabled) return configuration();
    if (!priceCache || priceCache.at < Date.now() - 600000) {
      const price = await getStripe().prices.retrieve(priceId);
      if (!price.active || !price.recurring || price.type !== 'recurring' || price.unit_amount == null) fail('Subscription pricing is unavailable.', 503);
      priceCache = { at: Date.now(), data: { amount: price.unit_amount, currency: price.currency, interval: price.recurring.interval, intervalCount: price.recurring.interval_count } };
    }
    return { ...configuration(), ...priceCache.data };
  }
  async function checkout(account) {
    if (!enabled) fail('Pro checkout is not available yet.', 503);
    if (account.owner) fail('The owner already has access.');
    if (account.entitlement?.tier === 'pro' && ['active', 'trialing'].includes(account.entitlement.status) && account.entitlement.expiresAt > Date.now()) fail('Your Pro subscription is already active. Open billing settings to manage it.');
    await pricing();
    let customerId = account.billing?.customerId;
    if (!customerId) {
      const customer = await getStripe().customers.create({ metadata: { accountId: account.id } }, { idempotencyKey: `account-customer-${account.id}` });
      if (!/^cus_[A-Za-z0-9]+$/.test(customer.id || '')) fail('Billing is unavailable.', 503);
      customerId = customer.id;
      options.updateAccount(account.id, { billing: { ...(account.billing || {}), customerId } });
    }
    const subscriptions = await getStripe().subscriptions.list({ customer: customerId, limit: 100, status: 'all' });
    if (subscriptions.data.some(s => ['active', 'trialing', 'past_due', 'unpaid'].includes(s.status))) fail('A subscription already exists. Open billing settings to manage it.', 409);
    const session = await getStripe().checkout.sessions.create({
      mode: 'subscription', line_items: [{ price: priceId, quantity: 1 }],
      customer: customerId,
      client_reference_id: account.id,
      metadata: { accountId: account.id }, subscription_data: { metadata: { accountId: account.id } },
      success_url: origin + '/account?billing=returned', cancel_url: origin + '/account?billing=canceled',
      allow_promotion_codes: true,
    }, { idempotencyKey: `checkout-${account.id}-${Math.floor(Date.now() / 3600000)}` });
    if (!/^https:\/\/checkout\.stripe\.com\//.test(session.url || '')) fail('Checkout is unavailable.', 503);
    return { url: session.url };
  }
  async function portal(account) {
    if (!enabled || !account.billing?.customerId) fail('No billing account is linked.', 409);
    const session = await getStripe().billingPortal.sessions.create({ customer: account.billing.customerId, return_url: origin + '/account' });
    if (!/^https:\/\/billing\.stripe\.com\//.test(session.url || '')) fail('Billing settings are unavailable.', 503);
    return { url: session.url };
  }
  async function webhook(req) {
    if (!enabled) fail('Billing is not configured.', 503);
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 262144) fail('Webhook too large.', 413); chunks.push(chunk); }
    let event;
    try { event = getStripe().webhooks.constructEvent(Buffer.concat(chunks), req.headers['stripe-signature'], webhookSecret, 300); } catch { fail('Invalid webhook signature.', 400); }
    if (!event || !/^evt_[A-Za-z0-9]+$/.test(event.id || '') || !Number.isFinite(event.created)) fail('Invalid event.');
    if (!['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'].includes(event.type)) return { received: true, ignored: true };
    const snapshot = event.data?.object;
    if (!snapshot || !/^sub_[A-Za-z0-9]+$/.test(snapshot.id || '')) fail('Invalid subscription.');
    // Re-read canonical Stripe state: late and duplicate deliveries cannot resurrect a canceled plan.
    const subscription = event.type === 'customer.subscription.deleted' ? snapshot : await getStripe().subscriptions.retrieve(snapshot.id);
    const accountId = subscription.metadata?.accountId;
    const account = options.getAccount(accountId);
    if (!account || account.owner) return { received: true, ignored: true };
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
    if (!/^cus_[A-Za-z0-9]+$/.test(customerId || '')) fail('Invalid customer.');
    if (account.billing?.customerId && account.billing.customerId !== customerId) fail('Subscription customer does not match this account.', 409);
    if (account.billing?.events?.includes(event.id)) return { received: true, duplicate: true };
    if (account.billing?.eventCreated > event.created) return { received: true, ignored: true };
    const item = subscription.items?.data?.find(i => i.price?.id === priceId);
    const status = event.type === 'customer.subscription.deleted' ? 'canceled' : subscription.status;
    const periodEnd = Number(item?.current_period_end || subscription.current_period_end || 0) * 1000;
    const active = !!item && ['active', 'trialing'].includes(status) && periodEnd > Date.now();
    // Never accept browser-provided price, amount, customer, tier, or success URL as entitlement evidence.
    options.updateAccount(accountId, {
      billing: { customerId, subscriptionId: subscription.id, eventCreated: event.created, events: [...(account.billing?.events || []), event.id].slice(-100) },
      entitlement: { tier: active ? 'pro' : 'free', status: ['active', 'trialing', 'past_due', 'canceled'].includes(status) ? status : 'inactive', source: 'stripe', expiresAt: active ? periodEnd : null, eventId: event.id, updatedAt: Date.now() },
    });
    return { received: true };
  }
  return { configuration, pricing, checkout, portal, webhook };
};
