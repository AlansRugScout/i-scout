// ── REVENUECAT IAP WEBHOOK ─────────────────────────────────────────
// Receives Apple In-App Purchase events (via RevenueCat) and writes
// entitlement to the SAME `subscribers` fields the Stripe webhook uses,
// so an app purchaser and a web subscriber are indistinguishable.
//
// IDENTITY: RevenueCat app_user_id === subscribers.access_token
//   In the app, after /account/verify-code returns the token, call:
//       Purchases.logIn(access_token)
//   Every event below then arrives stamped with that token.
//
// REGISTER in server.js AFTER express.json() (i.e. after the middleware
// block around line 275), so req.body is parsed JSON:
//       const { setupRevenueCatWebhook } = require('./revenuecat-webhook');
//       setupRevenueCatWebhook(app);
//
// ENV: REVENUECAT_WEBHOOK_AUTH — a secret string you set in BOTH the
//      RevenueCat dashboard (webhook Authorization header) and Railway.

const { Pool } = require('pg');

// ⚠️ CONFIRM these limits match upsertSubscriber() in scout-engine.js so
//    the IAP path grants the IDENTICAL monthly allowance as Stripe does.
//    Labels must match your existing planLabels exactly (em dash included).
const IAP_PLANS = {
  'com.alankeane.3scouts.starter.monthly':   { plan: '3scouts Starter — $9.99/month',   limit: 20 },
  'com.alankeane.3scouts.collector.monthly': { plan: '3scouts Collector — $19.99/month', limit: 60 },
  'com.alankeane.3scouts.dealer.monthly':    { plan: '3scouts Dealer — $49.99/month',    limit: 150 },
};

const TOPUP_PRODUCT_ID = 'com.alankeane.3scouts.topup10';
const TOPUP_AMOUNT = 10;

// A fresh billing period restores the full monthly allowance.
// (Your Stripe path may not currently reset on renewal — see note in chat.)
const RESET_USED_ON_RENEWAL = true;

function planFor(productId) {
  return IAP_PLANS[productId] || null;
}

function setupRevenueCatWebhook(app) {
  app.post('/webhooks/revenuecat', async (req, res) => {
    // 1. Verify the shared secret RevenueCat sends in the Authorization header
    const auth = req.headers['authorization'] || '';
    if (!process.env.REVENUECAT_WEBHOOK_AUTH || auth !== process.env.REVENUECAT_WEBHOOK_AUTH) {
      console.error('RevenueCat webhook: bad Authorization header');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const event = req.body && req.body.event;
    if (!event || !event.id) {
      return res.status(400).json({ error: 'Malformed event' });
    }

    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const client = await pool.connect();
    try {
      // 2. Idempotency — never process the same event twice (RevenueCat retries on 5xx)
      const seen = await client.query('SELECT 1 FROM processed_iap_events WHERE event_id = $1', [event.id]);
      if (seen.rows.length) {
        console.log('RevenueCat webhook: duplicate event ignored', event.id);
        return res.status(200).json({ received: true, duplicate: true });
      }

      const type = event.type;
      const appUserId = event.app_user_id;                       // === subscribers.access_token
      const productId = event.new_product_id || event.product_id || '';

      console.log(`RevenueCat event: ${type} · user=${appUserId} · product=${productId}`);

      switch (type) {
        // New sub, monthly renewal, resubscribe, or tier up/downgrade
        case 'INITIAL_PURCHASE':
        case 'RENEWAL':
        case 'UNCANCELLATION':
        case 'PRODUCT_CHANGE': {
          const p = planFor(productId);
          if (!p) { console.error('RevenueCat: unknown product', productId); break; }
          const sql = RESET_USED_ON_RENEWAL
            ? `UPDATE subscribers
                  SET plan = $1, active = true, deep_analyses_limit = $2, deep_analyses_used = 0
                WHERE access_token = $3`
            : `UPDATE subscribers
                  SET plan = $1, active = true, deep_analyses_limit = $2
                WHERE access_token = $3`;
          const r = await client.query(sql, [p.plan, p.limit, appUserId]);
          if (r.rowCount === 0) {
            console.error('RevenueCat: no subscriber matched access_token', appUserId,
                          '— user likely purchased before logIn(); investigate.');
          }
          break;
        }

        // Consumable top-up — mirror the web /topup-success behaviour exactly
        case 'NON_RENEWING_PURCHASE': {
          if (productId === TOPUP_PRODUCT_ID) {
            await client.query(
              'UPDATE subscribers SET deep_analyses_limit = deep_analyses_limit + $1 WHERE access_token = $2',
              [TOPUP_AMOUNT, appUserId]
            );
          } else {
            console.log('RevenueCat: non-renewing purchase for unmapped product', productId);
          }
          break;
        }

        // Paid period has actually ended → revoke access
        case 'EXPIRATION': {
          await client.query(
            'UPDATE subscribers SET active = false WHERE access_token = $1',
            [appUserId]
          );
          break;
        }

        // Cancelled or billing hiccup, but paid time remains — Apple sends
        // EXPIRATION at the real cut-off, so we keep access for now.
        case 'CANCELLATION':
        case 'BILLING_ISSUE':
          console.log(`RevenueCat: ${type} noted for ${appUserId} — access retained until expiry`);
          break;

        default:
          console.log('RevenueCat: unhandled event type', type);
      }

      // 3. Mark processed
      await client.query('INSERT INTO processed_iap_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING', [event.id]);
      return res.status(200).json({ received: true });
    } catch (err) {
      console.error('RevenueCat webhook error:', err.message);
      // 500 → RevenueCat retries; safe because every path above is idempotent
      return res.status(500).json({ error: 'Server error' });
    } finally {
      client.release();
      await pool.end();
    }
  });

  console.log('RevenueCat IAP webhook registered at POST /webhooks/revenuecat');
}

module.exports = { setupRevenueCatWebhook };
