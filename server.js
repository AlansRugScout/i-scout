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
} = require('./scout-engine');

const app = express();
const PORT = process.env.PORT || 3000;
const resend = new Resend(process.env.RESEND_API_KEY);

// ── INITIALISE DATABASE ───────────────────────────────────────────
initDatabase().catch(err => console.error('DB init error:', err.message));

// ── SCHEDULER ────────────────────────────────────────────────────
// Run scouts every hour
setInterval(() => {
  runScouts().catch(err => console.error('Scout run error:', err.message));
}, 60 * 60 * 1000);

// Also run once on startup after 30 seconds
setTimeout(() => {
  runScouts().catch(err => console.error('Scout startup error:', err.message));
}, 30000);

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
    reply_to: 'alan@aka.ie',
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
  const { name, email, plan, category } = data;
  await resend.emails.send({
    from: '3scouts <scout@3scouts.com>',
    reply_to: 'alan@aka.ie',
    to: email,
    subject: `Your 3scouts Scout is active — welcome aboard`,
    html: `
      <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; background: #f5edd6; padding: 2rem; border-top: 4px solid #c9922a;">
        <h2 style="font-family: Georgia, serif; color: #2c1f0e; margin-bottom: 0.25rem;">Your Scout is Active</h2>
        <p style="color: #c9922a; font-size: 13px; font-weight: bold; letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 1.5rem;">${plan}</p>
        <p style="color: #2c1f0e; font-size: 16px; line-height: 1.75; margin-bottom: 1rem;">Dear ${name},</p>
        <p style="color: #5a3e20; font-size: 15px; line-height: 1.8; margin-bottom: 1rem;">
          Your 3scouts subscription is confirmed and your Scout is now watching eBay around the clock for <strong style="color: #2c1f0e;">${category}</strong>.
        </p>
        <p style="color: #5a3e20; font-size: 15px; line-height: 1.8; margin-bottom: 1.5rem;">
          The moment a genuine find appears, you'll receive an instant alert with the item image, asking price, and our quick valuation estimate. You can then request a full <strong style="color: #2c1f0e;">Deep Analysis</strong> on any find — covering authenticity, condition grading, comparable sales, and a detailed buying recommendation.
        </p>
        <div style="background: #ffffff; border: 1px solid #e8d9b5; border-left: 4px solid #c9922a; padding: 1.25rem 1.5rem; margin-bottom: 1.5rem;">
          <p style="font-family: Georgia, serif; font-size: 13px; font-weight: bold; color: #c9922a; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 0.75rem;">What happens next</p>
          <ol style="color: #5a3e20; font-size: 14px; line-height: 1.8; padding-left: 1.25rem; margin: 0;">
            <li>We'll confirm your brief is active within 24 hours</li>
            <li>Your Scout begins monitoring eBay immediately</li>
            <li>Matches trigger an instant standard alert with image and quick estimate</li>
            <li>Request a Deep Analysis on any find for the full professional appraisal</li>
          </ol>
        </div>
        <p style="color: #5a3e20; font-size: 15px; line-height: 1.8; margin-bottom: 1.5rem;">
          Any questions at all, simply reply to this email or contact us at <a href="mailto:alan@aka.ie" style="color: #c9922a;">alan@aka.ie</a>.
        </p>
        <div style="background: #2c1f0e; padding: 1rem 1.25rem; border-radius: 3px; text-align: center;">
          <p style="color: #e8b84b; font-size: 13px; margin: 0; letter-spacing: 0.04em;">3scouts.com &nbsp;·&nbsp; Powered by Anthropic & Claude Advanced Vision</p>
        </div>
        <p style="font-size: 12px; color: #8b6344; margin-top: 1rem; line-height: 1.6;">
          You are receiving this email because you subscribed to 3scouts at 3scouts.com.
          To manage your subscription, contact alan@aka.ie.
        </p>
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

    // Send welcome email
    try {
      await sendWelcomeEmail(data);
      console.log('Welcome email sent to', data.email);
    } catch (err) {
      console.error('Welcome email failed:', err.message);
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
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── CHECKOUT SESSION ──────────────────────────────────────────────
app.post('/create-checkout-session', async (req, res) => {
  const { plan, category, description, budget, name, email, negative, territories, frequency, images } = req.body;

  const priceMap = {
    trial:     process.env.STRIPE_PRICE_TRIAL,
    collector: process.env.STRIPE_PRICE_COLLECTOR,
    dealer:    process.env.STRIPE_PRICE_DEALER,
  };

  const priceId = priceMap[plan];
  if (!priceId) return res.status(400).json({ error: 'Invalid plan selected' });

  const planLabels = {
    trial:     '3scouts Starter — €20/month',
    collector: '3scouts Collector — €45/month',
    dealer:    '3scouts Dealer — €90/month',
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
      name:     session.metadata?.name     || 'Collector',
      plan:     session.metadata?.plan     || '3scouts',
      email:    session.customer_details?.email || '',
      category: session.metadata?.category || '',
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

// ── ROUTES ────────────────────────────────────────────────────────
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
