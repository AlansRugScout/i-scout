const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const path = require('path');
const { Resend } = require('resend');
const {
  initDatabase,
  runScouts,
  upsertSubscriber,
  deactivateSubscriber,
  runDeepAnalysis,
  runDeepAnalysisFromDescription,
  processFollowUpQueue,
  queueSubscriberSequence,
} = require('./scout-engine');

const app = express();
const PORT = process.env.PORT || 3000;
const resend = new Resend(process.env.RESEND_API_KEY);
const STRIPE_PORTAL_URL = 'https://billing.stripe.com/p/login/28E14g5sbcDi5nOc9b9Ve00';

// In-memory store for app login codes (email -> {code, accessToken, expires})
// Short-lived (10 min) so no DB table needed
const loginCodes = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [email, data] of loginCodes.entries()) {
    if (data.expires < now) loginCodes.delete(email);
  }
}, 60 * 1000);

// ── INITIALISE DATABASE ───────────────────────────────────────────
initDatabase().catch(err => console.error('DB init error:', err.message));

// ── SCHEDULER ────────────────────────────────────────────────────
// Run scouts at the top of every hour precisely
function scheduleTopOfHour() {
  const now = new Date();
  const msUntilNextHour = (60 - now.getMinutes()) * 60 * 1000 - now.getSeconds() * 1000 - now.getMilliseconds();

  console.log(`Next Scout run in ${Math.round(msUntilNextHour / 60000)} minutes`);

  setTimeout(() => {
    runScouts().catch(err => console.error('Scout run error:', err.message));
    // Then run every hour exactly
    setInterval(() => {
      runScouts().catch(err => console.error('Scout run error:', err.message));
    }, 60 * 60 * 1000);
  }, msUntilNextHour);
}

scheduleTopOfHour();

// Also run once on startup after 30 seconds
setTimeout(() => {
  runScouts().catch(err => console.error('Scout startup error:', err.message));
}, 30000);

// Process follow-up email queue every 10 minutes
setInterval(() => {
  processFollowUpQueue().catch(err => console.error('Follow-up queue error:', err.message));
}, 10 * 60 * 1000);
// Run once on startup
setTimeout(() => {
  processFollowUpQueue().catch(err => console.error('Follow-up startup error:', err.message));
}, 20000);

// ── EMAIL FUNCTIONS ───────────────────────────────────────────────

async function sendOwnerAlert(data) {
  const { name, email, plan, category, description, budget, negative, territories, frequency, images } = data;

  const attachments = (images || []).map((dataUrl, i) => {
    const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) {
      console.log(`Image ${i + 1}: could not parse data URL`);
      return null;
    }
    const mimeType = matches[1];
    const ext = mimeType.split('/')[1] || 'jpg';
    console.log(`Image ${i + 1}: mime=${mimeType} ext=${ext} size=${matches[2].length} chars`);
    return {
      filename: `reference-image-${i + 1}.${ext}`,
      content: Buffer.from(matches[2], 'base64'),
    };
  }).filter(Boolean);

  console.log(`Sending owner alert with ${attachments.length} attachment(s)`);

  await resend.emails.send({
    from: '3scouts <scout@3scouts.com>',
    reply_to: 'alan@3scouts.com',
    to: 'alan@aka.ie',
    subject: `New 3scouts subscriber — ${name} — ${plan}`,
    attachments: attachments.length > 0 ? attachments : undefined,
    html: `
      <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; background: #f5edd6; padding: 2rem; border-top: 4px solid #c9922a;">
        <h2 style="font-family: Georgia, serif; color: #2c1f0e; margin-bottom: 0.5rem;">New 3scouts Subscriber</h2>
        <p style="color: #8b6344; font-size: 14px; margin-bottom: 1.5rem;">Payment confirmed via Stripe. Scout brief details below.</p>
        <table style="width: 100%; border-collapse: collapse; font-size: 15px;">
          <tr style="border-bottom: 1px solid #e8d9b5;">
            <td style="padding: 10px 0; color: #8b6344; width: 140px;">Name</td>
            <td style="padding: 10px 0; color: #2c1f0e; font-weight: bold;">${name}</td>
          </tr>
          <tr style="border-bottom: 1px solid #e8d9b5;">
            <td style="padding: 10px 0; color: #8b6344;">Email</td>
            <td style="padding: 10px 0; color: #2c1f0e;"><a href="mailto:${email}" style="color: #c9922a;">${email}</a></td>
          </tr>
          <tr style="border-bottom: 1px solid #e8d9b5;">
            <td style="padding: 10px 0; color: #8b6344;">Plan</td>
            <td style="padding: 10px 0; color: #2c1f0e; font-weight: bold;">${plan}</td>
          </tr>
          <tr style="border-bottom: 1px solid #e8d9b5;">
            <td style="padding: 10px 0; color: #8b6344;">Category</td>
            <td style="padding: 10px 0; color: #2c1f0e;">${category}</td>
          </tr>
          <tr style="border-bottom: 1px solid #e8d9b5;">
            <td style="padding: 10px 0; color: #8b6344;">Budget</td>
            <td style="padding: 10px 0; color: #2c1f0e;">${budget || 'Not specified'}</td>
          </tr>
          <tr style="border-bottom: 1px solid #e8d9b5;">
            <td style="padding: 10px 0; color: #8b6344;">Territories</td>
            <td style="padding: 10px 0; color: #2c1f0e;">${territories === 'all' ? 'All territories (worldwide)' : 'Selected territories — see brief'}</td>
          </tr>
          <tr style="border-bottom: 1px solid #e8d9b5;">
            <td style="padding: 10px 0; color: #8b6344;">Alert frequency</td>
            <td style="padding: 10px 0; color: #2c1f0e;">${frequency || 'Immediate'}</td>
          </tr>
          <tr style="border-bottom: 1px solid #e8d9b5;">
            <td style="padding: 10px 0; color: #8b6344;">Exclude keywords</td>
            <td style="padding: 10px 0; color: #2c1f0e;">${negative || 'None specified'}</td>
          </tr>
          <tr style="border-bottom: 1px solid #e8d9b5;">
            <td style="padding: 10px 0; color: #8b6344; vertical-align: top;">Brief</td>
            <td style="padding: 10px 0; color: #2c1f0e; line-height: 1.6;">${description || 'Not provided'}</td>
          </tr>
          <tr>
            <td style="padding: 10px 0; color: #8b6344; vertical-align: top;">Images</td>
            <td style="padding: 10px 0; color: #2c1f0e;">${images && images.length > 0 ? `${images.length} image(s) attached` : 'None uploaded'}</td>
          </tr>
        </table>
        <div style="margin-top: 1.5rem; background: #2c1f0e; padding: 1rem 1.25rem; border-radius: 3px;">
          <p style="color: #e8b84b; font-size: 13px; margin: 0;">Action required: activate this subscriber's Scout and reply to confirm within 24 hours.</p>
        </div>
        <p style="font-size: 12px; color: #8b6344; margin-top: 1rem;">3scouts.com · Powered by Anthropic & Claude Advanced Vision</p>
      </div>
    `
  });
}

async function sendWelcomeEmail(data) {
  const { name, email, plan } = data;
  const firstName = (name || '').trim().split(' ')[0] || 'there';

  await resend.emails.send({
    from: '3scouts <scout@3scouts.com>',
    reply_to: 'alan@3scouts.com',
    to: email,
    subject: 'Your 3scouts subscription is confirmed',
    html: `
      <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;background:#ffffff;padding:0;border-top:4px solid #c9922a;">
        <div style="padding:1.75rem 1.5rem 0.5rem;">
          <p style="font-size:11px;letter-spacing:2px;color:#c9922a;margin:0 0 12px;text-transform:uppercase;">3scouts · Payment confirmation</p>
          <p style="font-size:15px;color:#2c1f0e;line-height:1.85;margin:0 0 1rem;">Hello ${firstName},</p>
          <p style="font-size:15px;color:#2c1f0e;line-height:1.85;margin:0 0 1rem;">This confirms your 3scouts subscription: <strong>${plan}</strong>. Payment was successful, and it renews monthly until you cancel. You can manage or cancel anytime — one click, no questions.</p>
          <p style="font-size:15px;color:#2c1f0e;line-height:1.85;margin:0 0 1.5rem;"><a href="https://billing.stripe.com/p/login/28E14g5sbcDi5nOc9b9Ve00" style="color:#8b6344;">Manage my subscription</a></p>
          <p style="font-size:15px;color:#2c1f0e;line-height:1.85;margin:0 0 1rem;">A separate email is on its way with how to get the most from your subscription — including setting up Scout One.</p>
          <p style="font-size:15px;color:#2c1f0e;line-height:1.85;margin:1.5rem 0 0.25rem;">Best wishes,</p>
          <p style="font-size:15px;color:#2c1f0e;line-height:1.5;margin:0 0 1.5rem;">Alan Keane<br><span style="color:#8b6344;font-size:13px;">Founder, 3scouts</span></p>
        </div>
        <div style="border-top:1px solid #e8d9b5;padding:1rem 1.5rem;">
          <p style="font-size:12px;color:#8b6344;margin:0;line-height:1.6;">3scouts — antiques &amp; collectibles appraisal. Dublin, Ireland.<br>Questions? Just reply, or email <a href="mailto:alan@3scouts.com" style="color:#8b6344;">alan@3scouts.com</a></p>
        </div>
      </div>
    `
  });
}

// ── WEBHOOK ───────────────────────────────────────────────────────

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const data = {
      name:        session.metadata?.name        || 'Subscriber',
      email:       session.customer_details?.email || '',
      plan:        session.metadata?.plan        || '3scouts',
      category:    session.metadata?.category    || 'Not specified',
      description: session.metadata?.description || '',
      budget:      session.metadata?.budget      || '',
      negative_keywords: session.metadata?.negative || '',
      territories: session.metadata?.territories || 'all',
      frequency:   session.metadata?.frequency   || 'immediate',
    };

    console.log(`New subscriber: ${data.email} — ${data.plan} — ${data.category}`);

    // Save to database
    try {
      await upsertSubscriber(data);
      console.log('Subscriber saved to database');
    } catch (err) {
      console.error('Database save error:', err.message);
    }

    // Queue the new-subscriber email sequence (B1 welcome now, then B2/B3/B4).
    // Replaces the old standalone welcome so subscribers get ONE welcome, and
    // so web and app subscribers receive an identical sequence.
    try {
      await queueSubscriberSequence(data.email, data.name);
      console.log('Subscriber sequence queued for', data.email);
    } catch (err) {
      console.error('Sequence queue error:', err.message);
    }

    // Trial/billing confirmation (states the trial end date) — factual, and
    // separate from the B1 onboarding email, which follows shortly after.
    try {
      await sendWelcomeEmail(data);
      console.log('Trial confirmation sent to', data.email);
    } catch (err) {
      console.error('Welcome email failed:', err.message);
    }
  }

  // ── MONTHLY RENEWAL ──────────────────────────────────────────────
  // Without this, a paying web subscriber uses their allowance once and is
  // then locked out forever while still being charged. Resets usage at the
  // start of each new billing period.
  //
  // Unused TOP-UPS carry over; unused plan allowance does not. Top-ups are
  // treated as consumed after the plan allowance, so the unused top-up count
  // is: old_limit - MAX(allowance, old_used).
  if (event.type === 'invoice.paid') {
    const invoice = event.data.object;

    // Only act on a genuine renewal — not the $0 trial-start invoice, and not
    // the initial checkout (already handled by checkout.session.completed).
    if (invoice.billing_reason === 'subscription_cycle') {
      try {
        let email = invoice.customer_email;
        if (!email && invoice.customer) {
          const customer = await stripe.customers.retrieve(invoice.customer);
          email = customer.email;
        }
        if (!email) throw new Error('No customer email on invoice');

        const { Pool } = require('pg');
        const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
        const client = await pool.connect();

        // Derive the plan allowance from the stored plan label
        const cur = await client.query(
          'SELECT plan, deep_analyses_limit, deep_analyses_used FROM subscribers WHERE LOWER(email) = LOWER($1)',
          [email]
        );

        if (!cur.rows.length) {
          console.error('Renewal: no subscriber found for', email);
        } else {
          const plan = cur.rows[0].plan || '';
          const allowance = plan.includes('Dealer') ? 150 : plan.includes('Collector') ? 60 : 20;

          const upd = await client.query(
            `UPDATE subscribers
                SET deep_analyses_used = 0,
                    deep_analyses_limit = $1 + GREATEST(0, deep_analyses_limit - GREATEST($1, deep_analyses_used)),
                    active = true
              WHERE LOWER(email) = LOWER($2)
              RETURNING deep_analyses_limit`,
            [allowance, email]
          );
          console.log(`Renewal reset for ${email} — ${plan} — new limit ${upd.rows[0].deep_analyses_limit} (allowance ${allowance} + carried top-ups)`);
        }

        client.release();
        await pool.end();
      } catch (err) {
        console.error('Renewal reset error:', err.message);
      }
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    try {
      const customer = await stripe.customers.retrieve(subscription.customer);
      await deactivateSubscriber(customer.email);
      console.log('Subscriber deactivated:', customer.email);
    } catch (err) {
      console.error('Deactivation error:', err.message);
    }
  }

  res.json({ received: true });
});

// ── MIDDLEWARE ────────────────────────────────────────────────────
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const { setupRevenueCatWebhook } = require('./revenuecat-webhook');
   setupRevenueCatWebhook(app);
// ── CHECKOUT SESSION ──────────────────────────────────────────────
app.post('/create-checkout-session', async (req, res) => {
  const { plan, category, description, budget, name, email, negative, territories, frequency, images } = req.body;

  const priceMap = {
    trial:     process.env.STRIPE_PRICE_TRIAL,
    collector: process.env.STRIPE_PRICE_COLLECTOR,
    dealer:    process.env.STRIPE_PRICE_DEALER,
  };

  // Use GBP prices for UK subscribers if available
  const isUK = (territories || '').includes('EBAY_GB') && !(territories || '').includes('EBAY_IE');
  const gbpMap = {
    trial:     process.env.STRIPE_PRICE_TRIAL_GBP,
    collector: process.env.STRIPE_PRICE_COLLECTOR_GBP,
    dealer:    process.env.STRIPE_PRICE_DEALER_GBP,
  };
  const priceId = (isUK && gbpMap[plan]) ? gbpMap[plan] : priceMap[plan];
  if (!priceId) return res.status(400).json({ error: 'Invalid plan selected' });

  const planLabels = {
    trial:     '3scouts Starter — $9.99/month',
    collector: '3scouts Collector — $19.99/month',
    dealer:    '3scouts Dealer — $49.99/month',
  };

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      automatic_tax: { enabled: false },
      metadata: {
        plan:        planLabels[plan],
        name:        name || '',
        category:    category || '',
        description: (description || '').substring(0, 500),
        budget:      budget || '',
        negative:    (negative || '').substring(0, 200),
        territories: territories || 'all',
        frequency:   frequency || 'immediate',
      },
      subscription_data: {
        // No free trial — the free tier is now 3 free appraisals (no card),
        // and subscriptions charge immediately. (The 'trial' key is just the
        // internal name for the Starter price.)
        metadata: {
          plan:     planLabels[plan],
          name:     name || '',
          category: category || '',
        },
      },
      success_url: `${process.env.SITE_URL || 'https://www.3scouts.com'}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.SITE_URL || 'https://www.3scouts.com'}/#brief`,
    });

    // Send owner alert immediately with images
    try {
      await sendOwnerAlert({
        name, email, plan: planLabels[plan], category, description,
        budget, negative, territories, frequency, images: images || [],
      });
      console.log('Owner alert sent with', (images || []).length, 'image(s)');
    } catch (emailErr) {
      console.error('Owner alert failed:', emailErr.message);
    }

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe session error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── SESSION DETAILS ───────────────────────────────────────────────
app.get('/session-details', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'No session ID' });
  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    res.json({
      name:        session.metadata?.name        || 'Collector',
      plan:        session.metadata?.plan        || '3scouts',
      email:       session.customer_details?.email || '',
      category:    session.metadata?.description || session.metadata?.category || '',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DEEP ANALYSIS REQUEST ─────────────────────────────────────────
app.get('/deep-analysis', async (req, res) => {
  const { subscriber, item } = req.query;
  if (!subscriber || !item) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }

  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const client = await pool.connect();
    const result = await client.query('SELECT id FROM subscribers WHERE email = $1 AND active = true', [subscriber]);
    client.release();
    await pool.end();

    if (result.rows.length === 0) {
      return res.redirect('/?error=subscriber-not-found');
    }

    const subscriberId = result.rows[0].id;

    // Run deep analysis in background
    runDeepAnalysis(subscriberId, item)
      .then(() => console.log('Deep analysis completed'))
      .catch(err => console.error('Deep analysis error:', err.message));

    // Send confirmation page
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Deep Analysis Requested — 3scouts</title>
        <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600&family=EB+Garamond:wght@400;500&display=swap" rel="stylesheet">
        <style>
          body { background: #f5edd6; font-family: 'EB Garamond', serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
          .card { background: #fffdf7; border: 1px solid #b8945a; border-top: 4px solid #c9922a; border-radius: 3px; padding: 2.5rem; max-width: 480px; text-align: center; }
          h1 { font-family: 'Cinzel', serif; color: #2c1f0e; font-size: 1.4rem; margin-bottom: 0.75rem; }
          p { color: #5a3e20; font-size: 15px; line-height: 1.75; margin-bottom: 1rem; }
          a { display: inline-block; background: #c9922a; color: #2c1f0e; font-family: 'Cinzel', serif; font-size: 12px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; padding: 11px 24px; border-radius: 3px; text-decoration: none; margin-top: 0.5rem; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Deep Analysis Requested</h1>
          <p>Your Deep Analysis is underway. Scout Two and Scout Three are examining the listing now — you'll receive the full report by email within a few minutes.</p>
          <a href="https://www.3scouts.com">Return to 3scouts →</a>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('Deep analysis request error:', err.message);
    res.redirect('/');
  }
});

// ── FREE VALUATION REQUEST ────────────────────────────────────────
app.post('/request-valuation', async (req, res) => {
  const { name, email, description, images } = req.body;
  if (!email || !description) return res.status(400).json({ error: 'Missing fields' });
  console.log(`Free valuation request from ${email} with ${(images||[]).length} image(s)`);

  try {
    // Send owner alert with full details and images
    await sendOwnerAlert({
      name: name || 'Free valuation request',
      email,
      plan: 'Free Valuation',
      category: 'Free Valuation Request',
      description,
      budget: '', negative: '', territories: '', frequency: '',
      images: images || [],
    });

    // Check if existing subscriber
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const client = await pool.connect();
    const result = await client.query('SELECT * FROM subscribers WHERE email = $1 AND active = true', [email]);
    client.release();
    await pool.end();

    if (result.rows.length > 0) {
      // Existing subscriber — use their allowance
      const subscriber = result.rows[0];
      if (subscriber.deep_analyses_used < subscriber.deep_analyses_limit) {
        runDeepAnalysisFromDescription(subscriber.id, description, images || [])
          .catch(err => console.error('Valuation error:', err.message));
      }
    } else {
      // New visitor — check if they've already had a free valuation
      const pool2 = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      const client2 = await pool2.connect();

      // Check if this email has already used a free valuation
      const existingFree = await client2.query(
        `SELECT id, deep_analyses_used, deep_analyses_limit, plan FROM subscribers WHERE email = $1`,
        [email]
      );

      if (existingFree.rows.length > 0) {
        const existing = existingFree.rows[0];
        // If they already had a free valuation (plan = Free Valuation and used >= limit)
        if (existing.plan === 'Free Valuation' && existing.deep_analyses_used >= existing.deep_analyses_limit) {
          client2.release();
          await pool2.end();
          return res.status(403).json({ 
            error: 'already_used',
            message: 'You have already used your free valuation. Subscribe to get more analyses.'
          });
        }
      }

      const accessToken = require('crypto').randomBytes(16).toString('hex');
      await client2.query(
        `INSERT INTO subscribers (name, email, plan, category, description, territories, frequency, active, deep_analyses_limit, deep_analyses_used, access_token)
         VALUES ($1, $2, 'Free Valuation', 'Free Valuation', $3, 'all', 'twice', false, 3, 0, $4)
         ON CONFLICT (email) DO NOTHING`,
        [name || 'Visitor', email, description, accessToken]
      );
      const newSub = await client2.query('SELECT id, deep_analyses_used, deep_analyses_limit, plan FROM subscribers WHERE email = $1', [email]);
      client2.release();
      await pool2.end();

      if (newSub.rows.length > 0) {
        const sub = newSub.rows[0];
        // Block if they already consumed their free valuation
        if (sub.deep_analyses_used >= sub.deep_analyses_limit) {
          return res.status(403).json({
            error: 'already_used',
            name: name || 'there',
            email: email,
            message: 'You have used all 3 of your free appraisals. Subscribe from $9.99/month to get 20 Deep Analyses per month plus eBay monitoring.'
          });
        }
        runDeepAnalysisFromDescription(sub.id, description, images || [])
          .catch(err => console.error('Free valuation error:', err.message));
      }
    }

    console.log(`Free valuation requested by ${email}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Free valuation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── VALUATION CHECKOUT (new subscriber) ──────────────────────────
app.post('/create-valuation-session', async (req, res) => {
  const { plan, name, email, description, images } = req.body;

  // For €1 one-off, use the trial price but create a one-time payment
  const priceId = plan === 'valuation'
    ? process.env.STRIPE_PRICE_TRIAL  // We'll use trial for now — Phase 2 add dedicated €1 price
    : process.env.STRIPE_PRICE_TRIAL;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      automatic_tax: { enabled: false },
      metadata: {
        plan:        '3scouts Starter — $9.99/month',
        name:        name || '',
        category:    'Item Valuation Request',
        description: (description || '').substring(0, 500),
        valuation:   'true',
      },
      success_url: `${process.env.SITE_URL || 'https://www.3scouts.com'}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.SITE_URL || 'https://www.3scouts.com'}/#value`,
    });

    // Send owner alert with images immediately
    try {
      await sendOwnerAlert({
        name, email,
        plan: '3scouts Starter — $9.99/month',
        category: 'Item Valuation Request',
        description, budget: '', negative: '', territories: '', frequency: '',
        images: images || [],
      });
    } catch (emailErr) {
      console.error('Valuation owner alert failed:', emailErr.message);
    }

    res.json({ url: session.url });
  } catch (err) {
    console.error('Valuation session error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── TOP-UP CHECKOUT ───────────────────────────────────────────────
app.get('/topup', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.redirect('/');

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: email,
      line_items: [{
        price: process.env.STRIPE_PRICE_TOPUP,
        quantity: 1,
      }],
      metadata: { email, topup: 'true' },
      success_url: `${process.env.SITE_URL}/topup-success?email=${encodeURIComponent(email)}`,
      cancel_url: `${process.env.SITE_URL}/`,
    });
    res.redirect(session.url);
  } catch (err) {
    console.error('Top-up session error:', err.message);
    res.redirect('/');
  }
});

app.get('/topup-success', async (req, res) => {
  const { email } = req.query;
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Top-up confirmed — 3scouts</title>
      <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600&family=EB+Garamond:wght@400;500&display=swap" rel="stylesheet">
      <style>
        body { background:#f5edd6; font-family:'EB Garamond',serif; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; }
        .card { background:#fffdf7; border:1px solid #b8945a; border-top:4px solid #c9922a; border-radius:3px; padding:2.5rem; max-width:480px; text-align:center; }
        h1 { font-family:'Cinzel',serif; color:#2c1f0e; font-size:1.4rem; margin-bottom:0.75rem; }
        p { color:#5a3e20; font-size:15px; line-height:1.75; margin-bottom:1rem; }
        a { display:inline-block; background:#c9922a; color:#2c1f0e; font-family:'Cinzel',serif; font-size:12px; font-weight:700; letter-spacing:1px; text-transform:uppercase; padding:11px 24px; border-radius:3px; text-decoration:none; margin-top:0.5rem; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Top-up confirmed</h1>
        <p>10 Deep Analyses have been added to your account. Your Scout is back at full strength.</p>
        <a href="https://www.3scouts.com">Return to 3scouts →</a>
      </div>
    </body>
    </html>
  `);

  // Add 10 analyses to subscriber's limit
  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const client = await pool.connect();
    await client.query(
      'UPDATE subscribers SET deep_analyses_limit = deep_analyses_limit + 10 WHERE email = $1',
      [email]
    );
    client.release();
    await pool.end();
    console.log(`Top-up applied for ${email} — +10 analyses`);
  } catch (err) {
    console.error('Top-up database error:', err.message);
  }
});

// ── REPORT PAGE ───────────────────────────────────────────────────
function formatPrice(raw) {
  if (!raw) return '';
  // "19995.00 GBP" → "£19,995"  |  "249.00 USD" → "$249"  |  "1200.00 EUR" → "€1,200"
  const currencySymbols = { GBP: '£', USD: '$', EUR: '€', AUD: 'A$', CAD: 'C$' };
  const m = String(raw).match(/^([\d,]+(?:\.\d+)?)\s*([A-Z]{3})?$/) ||
            String(raw).match(/^([£€$])?([\d,]+(?:\.\d+)?)\s*([A-Z]{3})?$/);
  if (!m) return raw;
  const numStr = (m[1] || m[2] || '').replace(/,/g, '');
  const num = parseFloat(numStr);
  if (isNaN(num)) return raw;
  const currCode = m[3] || m[2] || '';
  const sym = currencySymbols[currCode] || (m[1] && ['£','€','$'].includes(m[1]) ? m[1] : '£');
  return sym + num.toLocaleString('en-GB', { maximumFractionDigits: 0 });
}

function generateReportPage(report, images, isEbay, dateStr) {
  const analysisText = (report.analysis_text || '').replace(/^End of Report[^\n]*/im, '').trim();

  // Photo count note for footnote
  const photoCount = images ? images.length : 0;
  const photoCountNote = photoCount > 0
    ? ` &nbsp;·&nbsp; This report is based on ${photoCount} photograph${photoCount > 1 ? 's' : ''} provided. If additional photos exist showing marks, hallmarks or damage not visible in the submitted images, these may affect this assessment.`
    : '';

  // ── Parse structured fields ──────────────────────────────────────
  let confidence = null;
  const confMatch = analysisText.match(/Authenticity\s+Confidence[:\s]+(\d+)\s*(?:%|percent)/i)
    || analysisText.match(/[Cc]onfidence\s+in\s+authenticity[:\s]+(\d+)\s*%/i)
    || analysisText.match(/[Cc]onfidence[:\s]+(\d+)\s*%/i)
    || analysisText.match(/authenticity[^.]{0,60}?(\d+)\s*%/i)
    || analysisText.match(/(\d+)\s*%\s+confidence/i)
    || analysisText.match(/confidence\s+(?:of\s+)?(\d+)\s*%/i)
    || analysisText.match(/(\d+)\s*%\s+(?:that\s+)?(?:this\s+)?(?:is\s+)?(?:genuine|authentic)/i);
  if (confMatch) confidence = parseInt(confMatch[1]);

  let grade = null;
  const gradeMatch =
    analysisText.match(/Overall\s+Grade[:\s]+([A-D][+-]?)/i) ||
    analysisText.match(/Overall\s+grade[:\s]+([A-D](?:\s+(?:plus|minus))?)/i) ||
    analysisText.match(/overall\s+condition[^\n]{0,20}([A-D][+-])/i);
  if (gradeMatch) {
    let g = gradeMatch[1].trim()
      .replace(/\s+plus$/i, '+')
      .replace(/\s+minus$/i, '-');
    grade = g.toUpperCase();
  }
  // Fallback: find most common component grade
  if (!grade) {
    const gradeMatches = [...analysisText.matchAll(/[Gg]rade[:\s]+([A-D][+-]?)/g)];
    if (gradeMatches.length >= 2) {
      const grades = gradeMatches.map(m => m[1].toUpperCase());
      const freq = {};
      grades.forEach(g => freq[g] = (freq[g]||0) + 1);
      grade = Object.entries(freq).sort((a,b) => b[1]-a[1])[0][0];
    }
  }
  // Final fallback: look for any letter grade mentioned with condition words
  if (!grade) {
    const condMatch = analysisText.match(/condition[^\n]{0,30}([A-D][+-]?)[^\w]/i)
      || analysisText.match(/([A-D][+-]?)\s*[—–-]\s*(?:excellent|very good|good|fair|poor)/i);
    if (condMatch) grade = condMatch[1].toUpperCase();
  }

  let valuation = null;
  const valPatterns = [
    /Fair\s+Market\s+Value[^€£$\d\n]{0,30}([€£$][\d,.]+(?:\s*(?:to|–|-)\s*[€£$][\d,.]+)?)/i,
    /fair\s+open\s+market\s+value[^€£$\d\n]{0,30}([€£$][\d,.]+(?:\s*(?:to|–|-)\s*[€£$][\d,.]+)?)/i,
    /estimated?\s+(?:fair\s+)?(?:market\s+)?value[^€£$\d\n]{0,30}([€£$][\d,.]+(?:\s*(?:to|–|-)\s*[€£$][\d,.]+)?)/i,
    /(?:current|retail|auction|replacement)\s+(?:market\s+)?value[^€£$\d\n]{0,30}([€£$][\d,.]+(?:\s*(?:to|–|-)\s*[€£$][\d,.]+)?)/i,
    /value[^€£$\d\n]{0,20}([€£$][\d,.]+\s*(?:–|-|to)\s*[€£$][\d,.]+)/i,
    /sell\s+for[^€£$\d\n]{0,20}([€£$][\d,.]+(?:\s*(?:to|–|-)\s*[€£$][\d,.]+)?)/i,
    // Mid-market / multi-tier estimate formats
    /mid[- ]market\s+estimate[^€£$\d]{0,80}([€£$][\d,.]+\s*(?:to|–|-)\s*[€£$][\d,.]+)/i,
    /mid[- ]range\s+estimate[^€£$\d]{0,80}([€£$][\d,.]+\s*(?:to|–|-)\s*[€£$][\d,.]+)/i,
    /estimate[^€£$\d]{0,60}([€£$][\d,.]+\s*(?:–|-|to)\s*[€£$][\d,.]+)/i,
    /fair\s+value\s+range[^€£$\d\n]{0,30}([€£$][\d,.]+\s*(?:to|–|-)\s*[€£$][\d,.]+)/i,
    /range\s+of[^€£$\d\n]{0,20}([€£$][\d,.]+\s*(?:to|–|-)\s*[€£$][\d,.]+)/i,
    /between[^€£$\d\n]{0,20}([€£$][\d,.]+)\s*(?:and|to)\s*([€£$][\d,.]+)/i,
    /([€£$][\d,.]+\s*(?:–|to)\s*[€£$][\d,.]+)[^\n]{0,60}(?:fair|value|estimate|valuation)/i,
    /(?:achieve|fetch|realise|realize|command|worth|priced?)[^€£$\d\n]{0,30}([€£$][\d,.]+\s*(?:–|-|to)\s*[€£$][\d,.]+)/i,
    /([€£$][\d,.]+\s*(?:–|-|to)\s*[€£$][\d,.]+)[^\n]{0,40}(?:achieve|fetch|realise|realize|market|auction|condition)/i,
    /(?:valuation|valued?)[^€£$\d]{0,50}([€£$][\d,.]+\s*(?:–|-|to)\s*[€£$][\d,.]+)/i,
    /valuation\s+(?:for[^€£$\d]{0,50})?is[:\s]+([€£$][\d,.]+\s*(?:–|-|to)\s*[€£$][\d,.]+)/i,
    /market\s+valuation[^€£$\d]{0,80}([€£$][\d,.]+\s*(?:to|–|-)\s*[€£$][\d,.]+)/i,
    /([€£$][\d,.]+)\s*(?:–|-|to)\s*([€£$][\d,.]+)\s*(?:at\s+)?(?:auction|market|retail|private\s+sale)/i,
    // Fallback: first currency range found anywhere in text
    /([€£$][\d,.]+(?:\.\d+)?)\s*(?:to|–|-)\s*([€£$][\d,.]+(?:\.\d+)?)/i,
    /(\d[\d,.]+)\s*(?:euro|euros|eur|gbp|usd|dollars?|pounds?)\s*(?:to|–|-)\s*(\d[\d,.]+)\s*(?:euro|euros|eur|gbp|usd|dollars?|pounds?)/i,
    /(?:conservative|retail|estimate|value|worth)[^€£$\d\n]{0,30}(\d[\d,.]+)\s*(?:euro|euros|eur|gbp|usd|dollars?|pounds?)\s*(?:to|–|-)\s*(\d[\d,.]+)/i,
  ];
  for (const pat of valPatterns) {
    const m = analysisText.match(pat);
    if (m) {
      // If two capture groups (from "between X and Y" or word-based currency), format with dash
      if (m[2]) {
        // Check if values already have currency symbols
        const v1 = m[1].trim();
        const v2 = m[2].trim();
        const hasSym = /^[€£$]/.test(v1);
        // Detect word currency in surrounding text
        const wordEuro = /euro|eur/i.test(m[0]);
        const wordGbp = /gbp|pound/i.test(m[0]);
        const wordUsd = /usd|dollar/i.test(m[0]);
        const wordAud = /aud|australian/i.test(m[0]);
        const wordCad = /cad|canadian/i.test(m[0]);
        const sym = hasSym ? '' : wordGbp ? '£' : wordAud ? 'A$' : wordCad ? 'C$' : wordUsd ? '$' : wordEuro ? '€' : '';
        valuation = `${sym}${v1} – ${sym}${v2}`;
      } else {
        valuation = m[1].trim();
      }
      break;
    }
  }

  // ── Parse sections ───────────────────────────────────────────────
  const sections = [];
  let currentSection = null;
  let currentLines = [];
  const lines = analysisText.split('\n').map(l => l.trim()).filter(l => l && l !== '---');

  for (const line of lines) {
    const clean = line.replace(/^#{1,3}\s+/, '');
    const numMatch = clean.match(/^(\d+)\.\s+(.+)/);
    if (numMatch) {
      if (currentSection) sections.push({ title: currentSection, lines: currentLines });
      currentSection = numMatch[2].replace(/\*\*/g, '');
      currentLines = [];
    } else {
      currentLines.push(clean);
    }
  }
  if (currentSection) sections.push({ title: currentSection, lines: currentLines });

  // ── Confidence display ───────────────────────────────────────────
  const confColor = confidence === null ? '#c9922a'
    : confidence >= 80 ? '#1a4a2e'
    : confidence >= 60 ? '#c9922a' : '#8b2020';
  const confBadgeClass = confidence === null ? 'badge-warn'
    : confidence >= 80 ? 'badge-pass'
    : confidence >= 60 ? 'badge-warn' : 'badge-fail';
  const confBadgeText = confidence === null ? '— Confidence unknown'
    : confidence >= 80 ? `◈ Authentic — Confidence: ${confidence}%`
    : confidence >= 60 ? `⚠ Probable — Confidence: ${confidence}%`
    : `✕ Uncertain — Confidence: ${confidence}%`;
  const confVerdictClass = confidence === null ? 'verdict-warn'
    : confidence >= 80 ? 'verdict-pass'
    : confidence >= 60 ? 'verdict-warn' : 'verdict-fail';

  // ── Grade display ────────────────────────────────────────────────
  const gradeColors = {'A+':'#1a6b2e','A':'#1a6b2e','A-':'#2d8a3e','B+':'#4a7a1a','B':'#c9922a','B-':'#d4882a','C+':'#8b4a1e','C':'#8b3010','C-':'#8b2020','D':'#6b1010'};
  const gradeWidths = {'A+':100,'A':92,'A-':85,'B+':78,'B':70,'B-':62,'C+':54,'C':46,'C-':38,'D':25};
  const gradeDescs = {'A+':'Exceptional condition','A':'Excellent condition','A-':'Excellent condition','B+':'Very good condition','B':'Good condition','B-':'Good condition','C+':'Fair condition','C':'Fair condition','C-':'Below average condition','D':'Poor condition'};
  const gc = gradeColors[grade] || '#c9922a';
  const gw = gradeWidths[grade] || 60;
  const gd = gradeDescs[grade] || 'Condition assessed';

  // ── Photo grid ───────────────────────────────────────────────────
  const photoGrid = images.map(img => `
    <div style="flex-shrink:0;border:2px solid var(--parchment-dk);border-radius:3px;overflow:hidden;box-shadow:0 3px 10px var(--shadow);background:#fff;">
      <img src="${img}" alt="Item photo" loading="lazy" style="display:block;width:190px;height:155px;object-fit:cover;" onerror="this.parentElement.style.display='none'">
    </div>`).join('');

  // ── Build sections HTML ──────────────────────────────────────────
  const sectionsHtml = sections.map(s => {
    const rawTitle = s.title.replace(/^\d+\.\s*/, '').toUpperCase();
    const contentLines = s.lines.filter(l => l);
    if (!contentLines.length) return '';

    const isAuth = /AUTHENTICITY/i.test(s.title);
    const isCond = /CONDITION/i.test(s.title);
    const isComp = /COMPARABLE|SALES/i.test(s.title);
    const isVal  = /VALUATION/i.test(s.title);
    const isRec  = /RECOMMENDATION/i.test(s.title);
    const isRed  = /RED FLAG/i.test(s.title);

    // ── AUTHENTICITY: verdict box ──
    if (isAuth) {
      const bodyLines = contentLines
        .filter(l => !l.match(/Authenticity\s+Confidence[:\s]+\d+/i))
        .map(l => l.replace(/\*\*/g, ''));
      return `
  <div class="rpt-section">
    <h2>${rawTitle}</h2>
    <div class="verdict ${confVerdictClass}">
      <div class="verdict-header">
        <span class="badge ${confBadgeClass}">${confBadgeText}</span>
      </div>
      <p class="verdict-text">${bodyLines.join(' ')}</p>
    </div>
  </div>`;
    }

    // ── CONDITION: grade box + bars ──
    if (isCond) {
      // Extract per-component grades
      const gradeBarLines = [];
      const otherLines = [];
      for (const l of contentLines) {
        const compMatch = l.match(/^(.{4,40}):\s+Grade\s+([A-D][+-]?)\s*[.–-]\s*(.+)/i)
          || l.match(/^(.{4,40}):\s+Grade\s+([A-D][+-]?)/i);
        const scoreMatch = l.match(/^(.{4,40}):\s+([\d.]+)\s*\/\s*10/i);
        if (compMatch) {
          const [,name,,desc] = compMatch;
          const g = compMatch[2];
          gradeBarLines.push({ name: name.trim(), grade: g, desc: (desc||'').trim(), pct: gradeWidths[g]||60, color: gradeColors[g]||'#c9922a' });
        } else if (scoreMatch) {
          const [,name,score] = scoreMatch;
          const pct = Math.round(parseFloat(score) * 10);
          const color = pct >= 75 ? '#639922' : pct >= 50 ? '#c9922a' : '#8b2020';
          gradeBarLines.push({ name: name.trim(), score: `${score} / 10`, pct, color });
        } else if (!l.match(/Overall\s+Grade/i)) {
          otherLines.push(l.replace(/\*\*/g,''));
        }
      }

      const barsHtml = gradeBarLines.map(b => `
      <div class="grade-row">
        <span class="grade-name">${b.name}</span>
        <div class="grade-track"><div class="grade-fill" style="width:${b.pct}%;background:${b.color};"></div></div>
        <span class="grade-score">${b.score || (b.grade + (b.desc ? ' — ' + b.desc : ''))}</span>
      </div>`).join('');

      const notesHtml = otherLines.length
        ? `<div class="grade-notes">${otherLines.join(' ')}</div>` : '';

      return `
  <div class="rpt-section">
    <h2>${rawTitle}</h2>
    <div class="overall-grade-row">
      <div class="grade-letter-box" style="background:${gc}15;border-color:${gc}55;">
        <span class="grade-letter" style="color:${gc};">${grade ? grade.replace(/[+-]/,'') : '—'}</span>
        ${grade && grade.match(/[+-]/) ? `<span class="grade-sub" style="color:${gc};">${grade.slice(-1)}</span>` : ''}
      </div>
      <div class="grade-desc">
        <strong>${gd}</strong>
        <span>${gd}</span>
      </div>
    </div>
    ${barsHtml ? `<div class="grade-bars">${barsHtml}</div>` : ''}
    ${notesHtml}
  </div>`;
    }

    // ── COMPARABLE SALES: table ──
    if (isComp) {
      const saleLines = [];
      const introLines = [];
      for (const l of contentLines) {
        const clean = l
          .replace(/^(First|Second|Third|Fourth|Fifth|Sixth)\s+comparable[:..]\s*/i,'')
          .replace(/^Comparable\s+\d+[:..]\s*/i,'')
          .replace(/^[\d]+\.\s*/,'')
          .replace(/\*\*/g,'').trim();
        if (!clean) continue;
        const hasPrice = clean.match(/[£€$][\d,]+/);
        const hasYear = clean.match(/\b(19|20)\d{2}\b/);
        const hasAuction = clean.match(/Christie|Sotheby|Bonhams|Phillips|Lyon|Woolley|Whyte|Adam|eBay|auction|gallery|galleries/i);
        const isSaleEntry = hasPrice && (hasYear || hasAuction);
        if (isSaleEntry && clean.length <= 120) {
          saleLines.push(clean);
        } else if (clean.length > 15) {
          introLines.push(clean);
        }
      }

      const tableRows = saleLines.map((l, i) => {
        const allPrices = [...l.matchAll(/[£€$][\d,]+/g)];
        const price = allPrices.length ? allPrices[allPrices.length - 1][0] : '';
        const desc = price ? l.slice(0, l.lastIndexOf(price)).trim().replace(/[,–-]\s*$/, '') + l.slice(l.lastIndexOf(price) + price.length).trim() : l;
        return `<tr>
          <td>${desc}</td>
          <td class="price">${price}</td>
        </tr>`;
      }).join('');

      const introHtml = introLines.map(l => `<p class="verdict-text" style="margin-bottom:10px;">${l}</p>`).join('');

      return `
  <div class="rpt-section">
    <h2>${rawTitle}</h2>
    ${introHtml}
    ${tableRows ? `<table class="comp-table">
      <thead><tr><th>Comparable sale</th><th>Price</th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table>` : ''}
  </div>`;
    }

    // ── VALUATION: dark split box ──
    if (isVal) {
      const bodyLines = contentLines
        .filter(l => !l.match(/Fair\s+Market\s+Value/i) && !l.match(/fair\s+open\s+market/i))
        .map(l => l.replace(/\*\*/g,''));
      return `
  <div class="rpt-section">
    <h2>${rawTitle}</h2>
    <div class="val-box">
      <div class="val-left">
        <div class="val-label">3scouts fair value estimate</div>
        <div class="val-range-big">${valuation || '—'}</div>
        <div class="val-sub">Based on photographs and comparable sales</div>
      </div>
      <div class="val-right">
        <h3>Assessment</h3>
        <p>${bodyLines.join(' ')}</p>
      </div>
    </div>
  </div>`;
    }

    // ── RECOMMENDATION: verdict box ──
    if (isRec) {
      const body = contentLines.map(l => l.replace(/\*\*/g,'')).join(' ');
      return `
  <div class="rpt-section">
    <h2>${rawTitle}</h2>
    <div class="verdict verdict-pass" style="background:var(--green-pale);border-left-color:var(--green);">
      <p class="verdict-text">${body}</p>
    </div>
  </div>`;
    }

    // ── RED FLAGS: warning box ──
    if (isRed) {
      const body = contentLines.map(l => l.replace(/\*\*/g,'')).join(' ');
      return `
  <div class="rpt-section">
    <h2>${rawTitle}</h2>
    <div class="verdict verdict-warn">
      <div class="verdict-header"><span class="badge badge-warn">⚠ Points to verify</span></div>
      <p class="verdict-text">${body}</p>
    </div>
  </div>`;
    }

    // ── DEFAULT: plain prov-box ──
    const body = contentLines.map(l => {
      const cl = l.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/^[-*]\s/,'');
      if (l.match(/^[-*]\s/)) return `<li style="margin-left:1.2rem;margin-bottom:4px;">${cl}</li>`;
      return `<p class="prov-text">${cl}</p>`;
    }).join('');

    return `
  <div class="rpt-section">
    <h2>${rawTitle}</h2>
    <div class="prov-box">${body}</div>
  </div>`;

  }).join('');

  // ── Assemble full page ───────────────────────────────────────────
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>3scouts Report — ${report.listing_title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=EB+Garamond:ital,wght@0,400;0,500;1,400;1,500&display=swap" rel="stylesheet">
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
  :root{
    --parchment:#f5edd6;--parchment-dk:#e8d9b5;--ink:#2c1f0e;--ink-lt:#5a3e20;
    --sepia:#8b6344;--sepia-lt:#b8945a;--gold:#c9922a;--gold-lt:#e8b84b;
    --red:#8b2020;--red-lt:#f7c1c1;--red-pale:#fcebeb;
    --green:#1a4a2e;--green-lt:#c0dd97;--green-pale:#eaf3de;
    --amber-lt:#fac775;--amber-pale:#faeeda;--blue-lt:#b5d4f4;--blue-pale:#e6f1fb;
    --white:#fffdf7;--shadow:rgba(44,31,14,0.15);
  }
  html{scroll-behavior:smooth;}
  body{background-color:var(--parchment);background-image:radial-gradient(ellipse at 20% 20%,rgba(139,99,68,0.07) 0%,transparent 60%),radial-gradient(ellipse at 80% 80%,rgba(139,99,68,0.05) 0%,transparent 60%);color:var(--ink);font-family:'EB Garamond',Georgia,serif;font-size:17px;line-height:1.7;}
  nav{position:sticky;top:0;z-index:100;background:var(--ink);border-bottom:2px solid var(--gold);padding:0 2.5rem;height:56px;display:flex;align-items:center;justify-content:space-between;}
  .nav-logo{font-family:'Cinzel',serif;font-size:1.1rem;font-weight:700;color:var(--gold-lt);text-decoration:none;letter-spacing:0.04em;display:inline-flex;align-items:center;gap:10px;}
  .nav-btns{display:flex;gap:8px;}
  .btn-nav{background:transparent;border:1px solid var(--gold);color:var(--gold);font-family:'EB Garamond',serif;font-size:13px;padding:6px 14px;border-radius:3px;cursor:pointer;transition:background .2s,color .2s;}
  .btn-nav:hover{background:var(--gold);color:var(--ink);}
  .btn-nav--print{border-color:var(--sepia-lt);color:var(--sepia-lt);}
  .btn-nav--print:hover{background:var(--sepia-lt);color:var(--ink);}
  .report-header{background:var(--ink);background-image:linear-gradient(160deg,#1a0e05 0%,#2c1f0e 60%,#1a0e05 100%);border-bottom:2px solid var(--gold);padding:2.5rem 2rem 2rem;}
  .report-header h1{font-family:'Cinzel',serif;font-size:clamp(1.2rem,3vw,1.8rem);font-weight:700;color:var(--white);margin-bottom:0.4rem;letter-spacing:0.01em;line-height:1.3;}
  .report-subtitle{font-size:13.5px;color:rgba(255,255,255,0.55);line-height:1.6;}
  .report-subtitle span{color:rgba(255,255,255,0.3);margin:0 7px;}
  .summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;margin-top:1.5rem;}
  .summary-card{background:rgba(255,255,255,0.06);border:1px solid rgba(201,146,42,0.2);border-radius:3px;padding:14px 16px;}
  .summary-label{font-family:'Cinzel',serif;font-size:10px;font-weight:600;letter-spacing:0.09em;text-transform:uppercase;color:var(--gold);margin-bottom:6px;}
  .summary-value{font-size:14px;font-weight:500;color:var(--white);}
  .summary-sub{font-size:12px;color:rgba(255,255,255,0.5);margin-top:3px;line-height:1.4;}
  .price-big{font-family:'Cinzel',serif;font-size:1.6rem;font-weight:700;color:var(--gold-lt);}
  .container{max-width:860px;margin:0 auto;padding:0 2rem;}
  .rpt-section{padding:1.75rem 0;border-bottom:1px solid var(--parchment-dk);}
  .rpt-section:last-of-type{border-bottom:none;}
  .rpt-section h2{font-family:'Cinzel',serif;font-size:1rem;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--gold);margin-bottom:1rem;}
  .verdict{border-radius:3px;padding:18px 20px;margin-bottom:12px;overflow-wrap:break-word;}
  .verdict-pass{background:var(--green-pale);border:1px solid var(--green-lt);border-left:4px solid var(--green);}
  .verdict-warn{background:var(--amber-pale);border:1px solid var(--amber-lt);border-left:4px solid var(--gold);}
  .verdict-fail{background:var(--red-pale);border:1px solid var(--red-lt);border-left:4px solid var(--red);}
  .verdict-header{display:flex;align-items:center;gap:10px;margin-bottom:9px;flex-wrap:wrap;}
  .badge{font-family:'Cinzel',serif;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;padding:4px 12px;border-radius:2px;}
  .badge-pass{background:var(--green-lt);color:#1a3a08;}
  .badge-warn{background:var(--amber-lt);color:#412402;}
  .badge-fail{background:var(--red-lt);color:#501313;}
  .verdict-text{font-size:15px;color:var(--ink-lt);line-height:1.8;overflow-wrap:break-word;}
  .photo-section{padding:1.5rem 0;border-bottom:1px solid var(--parchment-dk);}
  .photo-label{font-family:'Cinzel',serif;font-size:10px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:var(--sepia);margin-bottom:0.75rem;}
  .photo-grid{display:flex;flex-wrap:wrap;gap:12px;}
  .overall-grade-row{display:flex;align-items:flex-start;gap:16px;margin-bottom:1.5rem;flex-wrap:wrap;}
  .grade-letter-box{width:64px;height:64px;border-radius:3px;display:flex;flex-direction:column;align-items:center;justify-content:center;flex-shrink:0;}
  .grade-letter{font-family:'Cinzel',serif;font-size:1.9rem;font-weight:700;line-height:1;}
  .grade-sub{font-size:0.8rem;font-weight:600;}
  .grade-desc strong{font-size:15px;font-weight:600;color:var(--ink);display:block;margin-bottom:3px;}
  .grade-desc span{font-size:13.5px;color:var(--sepia);}
  .grade-bars{margin-bottom:1.25rem;}
  .grade-row{display:flex;align-items:center;gap:12px;margin-bottom:11px;}
  .grade-name{font-size:13.5px;color:var(--ink-lt);min-width:160px;flex-shrink:0;}
  .grade-track{flex:1;height:5px;background:var(--parchment-dk);border-radius:3px;overflow:hidden;}
  .grade-fill{height:100%;border-radius:3px;}
  .grade-score{font-size:13px;font-weight:600;min-width:160px;text-align:right;color:var(--ink);font-family:'Cinzel',serif;overflow-wrap:break-word;}
  .grade-notes{background:var(--white);border:1px solid var(--parchment-dk);border-radius:3px;padding:14px 16px;font-size:14.5px;color:var(--ink-lt);line-height:1.8;font-style:italic;overflow-wrap:break-word;}
  .prov-box{background:var(--white);border:1px solid var(--parchment-dk);border-radius:3px;padding:16px 18px;margin-bottom:10px;overflow-wrap:break-word;}
  .prov-label{font-family:'Cinzel',serif;font-size:10px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;color:var(--gold);margin-bottom:6px;}
  .prov-text{font-size:14.5px;color:var(--ink-lt);line-height:1.75;overflow-wrap:break-word;}
  .comp-table{width:100%;border-collapse:collapse;font-size:14px;}
  .comp-table th{font-family:'Cinzel',serif;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--sepia);text-align:left;padding:6px 8px 10px;border-bottom:1px solid var(--sepia-lt);}
  .comp-table td{padding:10px 8px;border-bottom:1px solid var(--parchment-dk);color:var(--ink-lt);vertical-align:top;line-height:1.5;overflow-wrap:break-word;}
  .comp-table td.price{font-family:'Cinzel',serif;font-weight:700;color:var(--ink);white-space:nowrap;}
  .val-box{background:var(--ink);background-image:linear-gradient(135deg,#1a0e05 0%,#2c1f0e 100%);border:1px solid var(--gold);border-radius:3px;padding:24px 26px;display:flex;align-items:flex-start;gap:2.5rem;flex-wrap:wrap;}
  .val-left{flex-shrink:0;}
  .val-label{font-family:'Cinzel',serif;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--gold);margin-bottom:8px;}
  .val-range-big{font-family:'Cinzel',serif;font-size:2.1rem;font-weight:700;color:var(--gold-lt);line-height:1;margin-bottom:7px;}
  .val-sub{font-size:13px;color:rgba(255,255,255,0.5);}
  .val-right{flex:1;min-width:220px;}
  .val-right h3{font-family:'Cinzel',serif;font-size:0.85rem;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:var(--gold);margin-bottom:9px;}
  .val-right p{font-size:14.5px;color:rgba(255,255,255,0.75);line-height:1.75;overflow-wrap:break-word;}
  .footnote{padding:1.5rem 0 2.5rem;font-size:12.5px;color:var(--sepia);line-height:1.75;}
  footer{background:#1a0e05;border-top:2px solid var(--gold);padding:2rem 2.5rem;}
  .footer-inner{max-width:860px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:1rem;}
  .footer-logo{font-family:'Cinzel',serif;font-size:1rem;font-weight:700;color:var(--gold-lt);text-decoration:none;}
  .footer-right{font-size:12px;color:rgba(255,255,255,0.35);}
  @media print{nav{display:none;}.no-print{display:none !important;}.report-header,.val-box{-webkit-print-color-adjust:exact;print-color-adjust:exact;}body{font-size:14px;}}
  @media(max-width:600px){
    nav{padding:0 1.25rem;}
    .container{padding:0 1.5rem;}
    .val-box{flex-direction:column;gap:1.5rem;padding:18px 16px;}
    .val-left{width:100%;}
    .val-right{width:100%;min-width:0;}
    .val-range-big{font-size:1.6rem;}
    .report-header{padding:2rem 1.5rem 1.5rem;}
    .report-header h1{font-size:1.1rem;}
    .grade-name{min-width:90px;font-size:12px;}
    .grade-score{min-width:80px;font-size:11px;}
    .rpt-section{padding:1.25rem 0;}
    .rpt-section h2{font-size:0.8rem;letter-spacing:0.03em;}
    .photo-section{padding:1.25rem 0;}
    .summary-grid{grid-template-columns:1fr 1fr;}
    .comp-table{font-size:12px;}
    .comp-table th,.comp-table td{padding:7px 5px;}
    .footnote{padding:1.25rem 0 2rem;}
    .photo-grid img{max-width:100%;height:auto;}
    .overall-grade-row{gap:10px;}
    .grade-letter-box{width:52px;height:52px;}
    .grade-letter{font-size:1.5rem;}
  }
</style>
</head>
<body>

<nav>
  <div class="nav-logo">
    <div style="display:flex;align-items:center;gap:4px;">
      <span style="display:block;width:9px;height:9px;border-radius:50%;background:#c9922a;"></span>
      <span style="display:block;width:9px;height:9px;border-radius:50%;background:#e8b84b;"></span>
      <span style="display:block;width:9px;height:9px;border-radius:50%;background:#c9922a;opacity:0.5;"></span>
    </div>
    3scouts<span style="font-size:0.72rem;color:#c9922a;letter-spacing:0.06em;">.com</span>
  </div>
  <div class="nav-btns">
    <button class="btn-nav btn-nav--print" onclick="window.print()">🖨 Print</button>
    <button class="btn-nav" onclick="savePDF()">⬇ Save as PDF</button>
  </div>
</nav>

<div class="report-header">
  <div class="container">
    <h1>${report.listing_title}</h1>
    <p class="report-subtitle">
      ${isEbay ? `eBay listing` : `Submitted by subscriber`}
      <span>·</span>
      ${isEbay ? 'Deep Analysis Report' : 'Valuation Report'}
      <span>·</span>
      ${dateStr}
      ${isEbay && report.listing_price ? `<span>·</span> Listed at ${report.listing_price}` : ''}
    </p>
    <div class="summary-grid">
      <div class="summary-card">
        <div class="summary-label">${isEbay ? 'Item identified' : 'Item submitted'}</div>
        <div class="summary-value">${report.listing_title}</div>
        ${isEbay && report.listing_url ? `<div class="summary-sub"><a href="${report.listing_url}" target="_blank" style="color:var(--gold);">View on eBay →</a></div>` : ''}
      </div>
      ${isEbay && report.listing_price ? `
      <div class="summary-card">
        <div class="summary-label">Asking price</div>
        <div class="price-big">${formatPrice(report.listing_price)}</div>
      </div>` : ''}
      <div class="summary-card">
        <div class="summary-label">Authenticity</div>
        <div style="font-family:'Cinzel',serif;font-size:1.5rem;font-weight:700;color:${confidence >= 80 ? '#4ade80' : confidence >= 60 ? '#e8b84b' : '#f87171'};line-height:1;margin-bottom:6px;">${confidence !== null ? confidence + '%' : '—'}</div>
        <div style="font-size:13px;color:rgba(255,255,255,0.85);line-height:1.5;">${confidence !== null ? (confidence >= 80 ? '◈ Strong indicators of authenticity' : confidence >= 60 ? '⚠ Probable — some uncertainty' : '✕ Significant uncertainty') : dateStr}</div>
      </div>
      ${valuation ? `
      <div class="summary-card">
        <div class="summary-label">Estimated value</div>
        <div class="price-big" style="font-size:1.3rem;">${valuation}</div>
      </div>` : ''}
    </div>
  </div>
</div>

<div style="padding-top:2rem;" class="container">

  ${images.length ? `<div class="photo-section">
    <p class="photo-label">${isEbay ? 'Listing photos' : 'Submitted photos'}</p>
    <div class="photo-grid">${photoGrid}</div>
  </div>` : ''}

  ${sectionsHtml}

  <p class="footnote">
    Without physically seeing and examining an item, no definitive appraisal can be made. This report is based on the photographs and description provided only. Valuations are estimates based on comparable sales data from our knowledge base and should not be taken as a guarantee of resale value. Authentication assessments do not replace physical examination by a qualified specialist. 3scouts accepts no liability for purchasing or selling decisions made on the basis of this report. For coins, stamps and trading cards: mintage figures, production data and card values are highly category-specific and volatile — always verify with specialist references and recent completed sales before buying or selling. For items from Japanese or Asian markets: regional pricing may differ significantly from Western market values.${photoCountNote} &nbsp;·&nbsp; Powered by Anthropic &amp; Claude Advanced Vision &nbsp;·&nbsp; <span style="color:var(--gold);">3scouts.com</span>  </p>

</div>

<footer>
  <div class="footer-inner">
    <a href="/" class="footer-logo" style="display:inline-flex;align-items:center;gap:10px;text-decoration:none;">
      <div style="display:flex;align-items:center;gap:4px;">
        <span style="display:block;width:8px;height:8px;border-radius:50%;background:#c9922a;"></span>
        <span style="display:block;width:8px;height:8px;border-radius:50%;background:#e8b84b;"></span>
        <span style="display:block;width:8px;height:8px;border-radius:50%;background:#c9922a;opacity:0.5;"></span>
      </div>
      <span style="font-family:Cinzel,serif;font-size:1.05rem;font-weight:700;color:#e8b84b;">3scouts<span style="font-size:0.7rem;color:#c9922a;">.com</span></span>
    </a>
    <div class="footer-right">Powered by Anthropic &amp; Claude Advanced Vision &nbsp;·&nbsp; <a href="/privacy" style="color:rgba(255,255,255,0.4);">Privacy Policy</a> &nbsp;·&nbsp; <a href="/terms.html" style="color:rgba(255,255,255,0.4);">Terms</a></div>
  </div>
</footer>

<script>
function savePDF(){
  const s=document.createElement('style');s.id='pdf-page-style';
  s.textContent='@page{size:A4;margin:10mm 12mm;}';
  document.head.appendChild(s);
  // Brief on-screen hint — the browser's print dialog is how "Save as PDF"
  // works; tell the user to pick PDF as the destination.
  const hint=document.createElement('div');
  hint.textContent='Tip: in the dialog, choose "Save as PDF" (or "PDF") as the destination.';
  hint.style.cssText='position:fixed;top:0;left:0;right:0;z-index:9999;background:#2c1f0e;color:#e8b84b;'+
    'font-family:Georgia,serif;font-size:14px;text-align:center;padding:12px;';
  hint.className='no-print';
  document.body.appendChild(hint);
  const t=document.title;document.title='3scouts-report';
  setTimeout(function(){
    window.print();
    document.title=t;
    document.head.removeChild(s);
    if(hint.parentNode) hint.parentNode.removeChild(hint);
  },400);
}
</script>
</body>
</html>`;
}



// ── ACCOUNT PORTAL ─────────────────────────────────────────────

// ── PWA ROUTES ──────────────────────────────────────────────────

// Personal install URL — /install/TOKEN serves app with token baked into manifest
app.get('/install/:token', async (req, res) => {
  const { token } = req.params;
  if (!token || !/^[a-f0-9]{32}$/.test(token)) return res.redirect('/app');
  
  // Verify token exists
  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const client = await pool.connect();
    const result = await client.query('SELECT id FROM subscribers WHERE access_token = $1', [token]);
    client.release();
    await pool.end();
    if (!result.rows.length) return res.redirect('/app');
  } catch(e) { return res.redirect('/app'); }

  // Serve a version of app.html with token pre-baked into a meta tag
  const path = require('path');
  const fs = require('fs');
  let html = fs.readFileSync(path.join(__dirname, 'public', 'app.html'), 'utf8');
  
  // Inject token as a meta tag so it's always available regardless of storage
  html = html.replace(
    '<meta name="theme-color" content="#2c1f0e">',
    `<meta name="theme-color" content="#2c1f0e">
<meta name="3scouts-token" content="${token}">`
  );
  
  // Serve with a token-specific manifest
  html = html.replace(
    '<link rel="manifest" href="/manifest.json">',
    `<link rel="manifest" href="/manifest-${token}.json">`
  );
  
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// Serve token-specific manifest
app.get('/manifest-:token.json', (req, res) => {
  const { token } = req.params;
  if (!token || !/^[a-f0-9]{32}$/.test(token)) return res.redirect('/manifest.json');
  
  const manifest = {
    name: '3scouts',
    short_name: '3scouts',
    description: 'Find it. Appraise it. Value it.',
    start_url: `/install/${token}`,
    id: `/install/${token}`,
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#2c1f0e',
    theme_color: '#2c1f0e',
    icons: [
      { src: '/icons/icon-192.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icons/icon-512.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any maskable' }
    ]
  };
  res.setHeader('Cache-Control', 'no-cache');
  res.json(manifest);
});


app.get('/app', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'app.html'));
});

app.get('/manifest.json', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'manifest.json'));
});

app.get('/sw.js', (req, res) => {
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(require('path').join(__dirname, 'public', 'sw.js'));
});

app.get('/my-account', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'my-account.html'));
});

app.post('/account/request-access', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  // Always return 200 — never reveal whether email exists
  res.json({ success: true });

  // ── DEMO ACCOUNT for Apple App Review ──
  // demo@3scouts.com always accepts code 123456
  if (email.toLowerCase().trim() === 'demo@3scouts.com') {
    loginCodes.set('demo@3scouts.com', {
      code: '123456',
      accessToken: process.env.DEMO_ACCESS_TOKEN || 'demo-token-3scouts',
      expires: Date.now() + 60 * 60 * 1000, // 1 hour
    });
    return;
  }

  // Fire email in background
  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const client = await pool.connect();
    let result = await client.query(
      'SELECT name, access_token FROM subscribers WHERE email = $1',
      [email.toLowerCase().trim()]
    );

    // If no account exists, create one automatically for new app users
    if (!result.rows.length) {
      const newToken = require('crypto').randomBytes(16).toString('hex');
      const firstName = email.split('@')[0]; // Use email prefix as placeholder name
      await client.query(
        `INSERT INTO subscribers (name, email, plan, category, description, territories, frequency, active, deep_analyses_limit, deep_analyses_used, access_token)
         VALUES ($1, $2, 'Free Valuation', 'Free Valuation', '', 'all', 'twice', false, 3, 0, $3)
         ON CONFLICT (email) DO NOTHING`,
        [firstName, email.toLowerCase().trim(), newToken]
      );
      result = await client.query(
        'SELECT name, access_token FROM subscribers WHERE email = $1',
        [email.toLowerCase().trim()]
      );
    }

    client.release();
    await pool.end();
    if (!result.rows.length) return;
    const { name, access_token } = result.rows[0];
    const accountUrl = `${process.env.SITE_URL}/install/${access_token}`;
    const appUrl = `3scouts://login?token=${access_token}`;

    // Generate 6-digit code for native app login
    const code = String(Math.floor(100000 + Math.random() * 900000));
    loginCodes.set(email.toLowerCase().trim(), {
      code,
      accessToken: access_token,
      expires: Date.now() + 10 * 60 * 1000, // 10 minutes
    });
    await resend.emails.send({
      from: '3scouts <scout@3scouts.com>',
      reply_to: 'alan@3scouts.com',
      to: email,
      subject: `Your 3scouts sign-in code: ${code}`,
      html: `
        <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;background:#ffffff;padding:0;border-top:4px solid #c9922a;">
          <div style="padding:1.75rem 1.5rem 0.5rem;">
            <p style="font-size:11px;letter-spacing:2px;color:#c9922a;margin:0 0 12px;text-transform:uppercase;">3scouts</p>
            <p style="font-size:15px;color:#2c1f0e;line-height:1.85;margin:0 0 1rem;">Hello ${name},</p>
            <p style="font-size:15px;color:#2c1f0e;line-height:1.85;margin:0 0 1rem;">Here is the code to sign in to your 3scouts account. Enter it on the sign-in screen to continue.</p>
            <p style="font-size:28px;font-weight:700;letter-spacing:6px;color:#2c1f0e;margin:1.25rem 0;font-family:Georgia,serif;">${code}</p>
            <p style="font-size:15px;color:#2c1f0e;line-height:1.85;margin:0 0 1rem;">The code is valid for 10 minutes. If you did not ask to sign in, you can safely ignore this message and nothing will happen.</p>
            <p style="font-size:15px;color:#2c1f0e;line-height:1.85;margin:0 0 1.5rem;">Prefer to use the website? You can also open your account here: <a href="${accountUrl}" style="color:#8b6344;">3scouts.com/account</a></p>
            <p style="font-size:15px;color:#2c1f0e;line-height:1.85;margin:1.5rem 0 0.25rem;">Best wishes,</p>
            <p style="font-size:15px;color:#2c1f0e;line-height:1.5;margin:0 0 1.5rem;">Alan Keane<br><span style="color:#8b6344;font-size:13px;">Founder, 3scouts</span></p>
          </div>
          <div style="border-top:1px solid #e8d9b5;padding:1rem 1.5rem;">
            <p style="font-size:12px;color:#8b6344;margin:0;line-height:1.6;">3scouts — antiques &amp; collectibles appraisal. Dublin, Ireland.<br>Questions? Just reply, or email <a href="mailto:alan@3scouts.com" style="color:#8b6344;">alan@3scouts.com</a></p>
          </div>
        </div>
      `,
    });
  } catch(err) {
    console.error('Account access email error:', err.message);
  }
});

// Verify 6-digit code from app login screen -> return access token
app.post('/account/verify-code', async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Email and code required' });

  const key = email.toLowerCase().trim();
  const entry = loginCodes.get(key);
  if (!entry) {
    return res.status(400).json({ error: 'Code expired or not found. Please request a new code.' });
  }
  if (entry.expires < Date.now()) {
    loginCodes.delete(key);
    return res.status(400).json({ error: 'Code expired. Please request a new code.' });
  }
  if (entry.code !== String(code).trim()) {
    return res.status(400).json({ error: 'Incorrect code. Please check and try again.' });
  }

  // Success — consume the code
  loginCodes.delete(key);

  // Enrich with current entitlement (non-fatal if it fails — token still returns)
  let entitlement = null;
  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const client = await pool.connect();
    const r = await client.query(
      'SELECT plan, active, deep_analyses_limit, deep_analyses_used FROM subscribers WHERE access_token = $1',
      [entry.accessToken]
    );
    client.release();
    await pool.end();
// ── SAVE BRIEF (APP-SAFE, NO PAYMENT) ──────────────────────────────
// Lets a signed-in app user create/update their Scout brief WITHOUT
// touching Stripe checkout. Required because launching an external
// payment flow from inside the iOS app breaks App Store Guideline 3.1.1.
//
// ADD this to server.js anywhere below express.json() — e.g. directly
// after the app.get('/account/data', ...) handler (~line 1443).
//
// The token check matches every other /account/* route: 32 hex chars.

app.post('/account/save-brief', async (req, res) => {
  const { token, description, negative, budget, territories, frequency } = req.body;

  if (!token || !/^[a-f0-9]{32}$/.test(token)) {
    return res.status(400).json({ error: 'Invalid token' });
  }
  if (!description || !description.trim()) {
    return res.status(400).json({ error: 'Please describe what you are scouting for.' });
  }
  if (!territories || !territories.trim()) {
    return res.status(400).json({ error: 'Please select at least one eBay market.' });
  }

  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const client = await pool.connect();

    const result = await client.query(
      `UPDATE subscribers
          SET description       = $1,
              negative          = $2,
              negative_keywords = $2,
              budget            = $3,
              territories       = $4,
              frequency         = $5
        WHERE access_token = $6
        RETURNING email`,
      [
        description.trim().substring(0, 2000),
        (negative || '').substring(0, 200),
        (budget || '').substring(0, 100),
        territories,
        frequency || 'twice',
        token,
      ]
    );

    client.release();
    await pool.end();

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Account not found.' });
    }

    console.log('Scout brief saved for', result.rows[0].email);
    res.json({ success: true });
  } catch (err) {
    console.error('save-brief error:', err.message);
    res.status(500).json({ error: 'Server error — please try again' });
  }
});
    if (r.rows.length) {
      const s = r.rows[0];
      const remaining = Math.max(0, (s.deep_analyses_limit || 0) - (s.deep_analyses_used || 0));
      // Paid subscriber on either rail = active AND not the Free Valuation tier.
      const isSubscribed = s.active === true && s.plan && s.plan !== 'Free Valuation';
      entitlement = {
        plan: s.plan,
        active: s.active,
        isSubscribed,              // app: true → suppress paywall, show "you're subscribed"
        deep_analyses_limit: s.deep_analyses_limit,
        deep_analyses_used: s.deep_analyses_used,
        remaining,
      };
    }
  } catch (err) {
    console.error('verify-code entitlement lookup error:', err.message);
  }

  res.json({ success: true, token: entry.accessToken, entitlement });
});
// ── ACCOUNT PORTAL ─────────────────────────────────────────────

// One-click unsubscribe from marketing emails (link in every sequence email).
// Transactional mail — sign-in codes, the appraisal report, billing notices —
// is unaffected; this only stops the nudge sequence.
app.get('/unsubscribe', async (req, res) => {
  const t = (req.query.t || '').trim();
  const page = (title, body) => `<!DOCTYPE html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${title} — 3scouts</title>
    <style>body{font-family:Georgia,serif;background:#f5edd6;color:#2c1f0e;max-width:520px;margin:0 auto;padding:3rem 1.5rem;line-height:1.7}
    h1{font-size:1.4rem;color:#2c1f0e}a{color:#c9922a}.box{background:#fff;border-left:4px solid #c9922a;padding:1.25rem 1.5rem;border-radius:3px}</style>
    </head><body><div class="box"><h1>${title}</h1>${body}</div></body></html>`;

  if (!/^[a-f0-9]{32}$/.test(t)) {
    return res.status(400).send(page('Link not recognised',
      `<p>This unsubscribe link doesn't look valid. If you'd like to opt out of emails, just reply to any 3scouts email and we'll take care of it.</p><p><a href="/">Back to 3scouts.com</a></p>`));
  }
  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const client = await pool.connect();
    const r = await client.query(
      'UPDATE subscribers SET unsubscribed = TRUE WHERE access_token = $1 RETURNING email',
      [t]
    );
    client.release();
    await pool.end();
    if (r.rowCount === 0) {
      return res.status(404).send(page('Already done',
        `<p>We couldn't find a matching subscription — you may already be unsubscribed. If you still receive emails, reply to any of them and we'll sort it.</p><p><a href="/">Back to 3scouts.com</a></p>`));
    }
    return res.send(page('You\'re unsubscribed',
      `<p>You won't receive any more promotional emails from 3scouts. You'll still get essential messages about your account — sign-in codes, appraisal reports you request, and billing.</p>
       <p>Changed your mind? Just reply to any 3scouts email and we'll add you back.</p>
       <p><a href="/">Back to 3scouts.com</a></p>`));
  } catch (err) {
    console.error('Unsubscribe error:', err.message);
    return res.status(500).send(page('Something went wrong',
      `<p>We couldn't process that just now. Please reply to any 3scouts email and we'll unsubscribe you manually.</p>`));
  }
});

// Smart download link (for the QR code): detects device and sends to the
// right store, or shows options on desktop.
app.get('/get', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'get.html'));
});

app.get('/privacy', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'privacy.html'));
});

app.get('/account', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'account.html'));
});

app.get('/account/data', async (req, res) => {
  const { t } = req.query;
  if (!t || !/^[a-f0-9]{32}$/.test(t)) return res.status(400).json({ error: 'Invalid token' });
  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const client = await pool.connect();
    const subResult = await client.query(
      'SELECT id, name, email, plan, deep_analyses_used, deep_analyses_limit, active, description, negative, territories FROM subscribers WHERE access_token = $1',
      [t]
    );
    if (!subResult.rows.length) { client.release(); await pool.end(); return res.status(404).json({ error: 'Account not found. Please use the link from your email.' }); }
    const sub = subResult.rows[0];
    const reportsResult = await client.query(
      `SELECT listing_title, completed_at, report_token, ebay_item_id
       FROM deep_analyses
       WHERE subscriber_id = $1
       ORDER BY completed_at DESC LIMIT 20`,
      [sub.id]
    );
    client.release();
    await pool.end();
    res.json({
      name: sub.name,
      email: sub.email,
      plan: sub.plan,
      deep_analyses_used: sub.deep_analyses_used,
      deep_analyses_limit: sub.deep_analyses_limit,
      active: sub.active,
      description: sub.description,
      negative: sub.negative || null,
      territories: sub.territories,
      reports: reportsResult.rows,
    });
  } catch(err) {
    console.error('Account data error:', err.message);
    res.status(500).json({ error: 'Server error — please try again' });
  }
});

app.post('/account/submit-valuation', async (req, res) => {
  const { token, description, images } = req.body;
  if (!token || !/^[a-f0-9]{32}$/.test(token)) return res.status(400).json({ error: 'Invalid token' });
  if (!description) return res.status(400).json({ error: 'Description is required' });
  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const client = await pool.connect();
    const subResult = await client.query(
      'SELECT id, deep_analyses_used, deep_analyses_limit, plan FROM subscribers WHERE access_token = $1',
      [token]
    );
    client.release();
    await pool.end();
    if (!subResult.rows.length) return res.status(404).json({ error: 'Account not found' });
    const sub = subResult.rows[0];
    if (sub.deep_analyses_used >= sub.deep_analyses_limit) {
      return res.status(403).json({ error: 'You have used all your Deep Analyses for this period. Please top up or upgrade your plan.' });
    }
    // Fire analysis in background
    runDeepAnalysisFromDescription(sub.id, description, images || [])
      .catch(err => console.error('Account valuation error:', err.message));
    res.json({ success: true });
  } catch(err) {
    console.error('Account submit error:', err.message);
    res.status(500).json({ error: 'Server error — please try again' });
  }
});

app.get('/report/:token', async (req, res) => {
  const { token } = req.params;
  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const client = await pool.connect();

    // Support both old numeric IDs and new hex tokens during migration
    let result;
    if (/^[a-f0-9]{32}$/.test(token)) {
      result = await client.query(
        `SELECT da.*, s.name as subscriber_name, s.description as brief, s.category
         FROM deep_analyses da
         JOIN subscribers s ON da.subscriber_id = s.id
         WHERE da.report_token = $1`,
        [token]
      );
    } else if (/^\d+$/.test(token)) {
      // Legacy numeric ID — still works for old reports
      result = await client.query(
        `SELECT da.*, s.name as subscriber_name, s.description as brief, s.category
         FROM deep_analyses da
         JOIN subscribers s ON da.subscriber_id = s.id
         WHERE da.id = $1`,
        [parseInt(token)]
      );
    } else {
      client.release();
      await pool.end();
      return res.status(404).send('Report not found');
    }
    client.release();
    await pool.end();

    if (!result.rows.length) return res.status(404).send('Report not found');
    const report = result.rows[0];

    let images = [];
    if (report.listing_image) {
      try {
        const parsed = JSON.parse(report.listing_image);
        images = Array.isArray(parsed) ? parsed : [report.listing_image];
      } catch(e) {
        images = report.listing_image.startsWith('http') || report.listing_image.startsWith('data:') ? [report.listing_image] : [];
      }
    }

    const isEbay = !report.ebay_item_id?.startsWith('valuation-');
    const dateStr = new Date(report.completed_at).toLocaleDateString('en-IE', { day: 'numeric', month: 'long', year: 'numeric' });

    res.send(generateReportPage(report, images, isEbay, dateStr));
  } catch(err) {
    console.error('Report page error:', err.message);
    res.status(500).send('Error loading report');
  }
});

// ── ROUTES ────────────────────────────────────────────────────────
app.get('/value', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'value.html'));
});

app.get('/success', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'success.html'));
});

app.get('*', (req, res) => {
  const file = req.path === '/' ? 'index.html' : req.path.replace(/^\//, '');
  const filePath = path.join(__dirname, 'public', file);
  res.sendFile(filePath, err => {
    if (err) res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });
});

// ── START ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`3scouts server running on port ${PORT}`);
});
