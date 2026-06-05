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
} = require('./scout-engine');

const app = express();
const PORT = process.env.PORT || 3000;
const resend = new Resend(process.env.RESEND_API_KEY);
const STRIPE_PORTAL_URL = 'https://billing.stripe.com/p/login/28E14g5sbcDi5nOc9b9Ve00';

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
  const description = data.description || data.category;

  const trialEndDate = new Date();
  trialEndDate.setDate(trialEndDate.getDate() + 30);
  const trialEndFormatted = trialEndDate.toLocaleDateString('en-IE', { day: 'numeric', month: 'long', year: 'numeric' });

  await resend.emails.send({
    from: '3scouts <scout@3scouts.com>',
    reply_to: 'alan@3scouts.com',
    to: email,
    subject: `Your 3scouts 30-day free trial is active`,
    html: `
      <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;background:#f5edd6;padding:0;border-top:4px solid #c9922a;">

        <div style="background:#2c1f0e;padding:1rem 1.5rem;border-bottom:2px solid #c9922a;">
          <p style="font-size:11px;letter-spacing:2px;color:#c9922a;margin:0 0 4px;text-transform:uppercase;">3scouts · Welcome</p>
          <h2 style="font-size:1.1rem;font-weight:500;color:#fffdf7;margin:0;">Your 30-day free trial is active</h2>
          <p style="font-size:13px;color:rgba(255,255,255,0.5);margin:5px 0 0;">${plan}</p>
        </div>

        <div style="padding:1.5rem;background:#ffffff;border-bottom:1px solid #e8d9b5;">
          <p style="font-size:15px;color:#2c1f0e;line-height:1.85;margin:0 0 1rem;">Dear ${name},</p>
          <p style="font-size:15px;color:#5a3e20;line-height:1.85;margin:0 0 1rem;">
            Your 3scouts subscription is confirmed and your Scout is now watching eBay around the clock for <strong style="color:#2c1f0e;">${description}</strong>.
          </p>
          <p style="font-size:15px;color:#5a3e20;line-height:1.85;margin:0 0 1.5rem;">
            The moment a genuine find appears you'll receive a digest alert with listing image, price and our quick valuation estimate. Click <strong style="color:#2c1f0e;">Deep Analysis</strong> on any find for the full professional appraisal.
          </p>
          <p style="font-size:15px;color:#5a3e20;line-height:1.85;margin:0 0 1.5rem;">
            Your Deep Analysis allowance works both ways — request an appraisal on any eBay listing your Scout finds, <em>or</em> submit photos of anything you already own or are considering buying. Inherited something and not sure what it's worth? Spotted something in a shop or at auction? That's what your allowance is for.
          </p>

          <div style="background:#f5edd6;border:1px solid #e8d9b5;border-left:4px solid #c9922a;padding:1rem 1.25rem;margin-bottom:1.25rem;border-radius:0 3px 3px 0;">
            <p style="font-family:Georgia,serif;font-size:12px;font-weight:700;color:#c9922a;letter-spacing:1.5px;text-transform:uppercase;margin:0 0 0.5rem;">Your free trial</p>
            <p style="font-size:14px;color:#2c1f0e;line-height:1.75;margin:0;">
              Your trial runs until <strong>${trialEndFormatted}</strong>. We'll send you a reminder 7 days before it ends so there are no surprises.<br><br>
              If you decide 3scouts isn't for you, cancel any time before <strong>${trialEndFormatted}</strong> and you won't be charged a penny. Cancelling takes one click — no forms, no phone calls, no questions asked.
            </p>
          </div>

          <div style="background:#f5edd6;border:1px solid #e8d9b5;border-left:4px solid #2c1f0e;padding:1rem 1.25rem;margin-bottom:1.5rem;border-radius:0 3px 3px 0;">
            <p style="font-family:Georgia,serif;font-size:12px;font-weight:700;color:#2c1f0e;letter-spacing:1.5px;text-transform:uppercase;margin:0 0 0.5rem;">What happens next</p>
            <ol style="color:#5a3e20;font-size:14px;line-height:1.8;padding-left:1.25rem;margin:0;">
              <li>Your Scout begins monitoring eBay immediately across multiple marketplaces</li>
              <li>Matches arrive as a digest alert with images and our quick estimate</li>
              <li>Request a Deep Analysis on any eBay find for the full professional appraisal</li>
              <li>Or take a photo of anything you own or are considering buying and request a Deep Analysis — identification, maker, condition, comparable sales and valuation, usually within the hour</li>
              <li>To refine your brief anytime, reply to this email</li>
            </ol>
          </div>

          <a href="https://billing.stripe.com/p/login/28E14g5sbcDi5nOc9b9Ve00" style="display:inline-block;background:transparent;color:#2c1f0e;font-family:Georgia,serif;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:10px 20px;border-radius:3px;text-decoration:none;border:1px solid #b8945a;white-space:nowrap;">Manage my subscription →</a>
        </div>

        <div style="background:#e8d9b5;padding:0.75rem 1.5rem;">
          <p style="font-size:12px;color:#8b6344;margin:0;line-height:1.7;">
            To cancel your free trial at any time, click <a href="https://billing.stripe.com/p/login/28E14g5sbcDi5nOc9b9Ve00" style="color:#c9922a;">Manage my subscription</a> — one click, instant, no questions asked. &nbsp;·&nbsp; <a href="https://www.3scouts.com" style="color:#c9922a;">3scouts.com</a>
          </p>
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
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
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
        ...(plan === 'trial' ? { trial_period_days: 30 } : {}),
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

      await client2.query(
        `INSERT INTO subscribers (name, email, plan, category, description, territories, frequency, active, deep_analyses_limit, deep_analyses_used)
         VALUES ($1, $2, 'Free Valuation', 'Free Valuation', $3, 'all', 'twice', false, 1, 0)
         ON CONFLICT (email) DO NOTHING`,
        [name || 'Visitor', email, description]
      );
      const newSub = await client2.query('SELECT * FROM subscribers WHERE email = $1', [email]);
      client2.release();
      await pool2.end();

      if (newSub.rows.length > 0) {
        runDeepAnalysisFromDescription(newSub.rows[0].id, description, images || [])
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
        plan:        '3scouts Starter — €20/month',
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
        plan: '3scouts Starter — €20/month',
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
function generateReportPage(report, images, isEbay, dateStr) {
  const analysisText = report.analysis_text || '';

  // Parse analysis into sections
  const sections = [];
  let currentSection = null;
  let currentContent = [];

  const lines = analysisText.split('\n').map(l => l.trim()).filter(l => l && l !== '---');

  for (const line of lines) {
    const clean = line.replace(/^#{1,3}\s+/, '');
    const sectionMatch = clean.match(/^(\d+)\.\s+(.+)/);
    const capsHeader = clean.match(/^([A-Z][A-Z\s\/&]+[A-Z])$/) && clean.length > 5 && !clean.match(/[a-z£€$]/);

    if (sectionMatch || capsHeader) {
      if (currentSection) sections.push({ title: currentSection, lines: currentContent });
      currentSection = sectionMatch ? sectionMatch[2].replace(/\*\*/g,'') : clean;
      currentContent = [];
    } else {
      currentContent.push(clean);
    }
  }
  if (currentSection) sections.push({ title: currentSection, lines: currentContent });

  // Detect confidence %
  let confidence = null;
  const confMatch = analysisText.match(/(\d+)%.*confidence|confidence.*?(\d+)%/i);
  if (confMatch) confidence = parseInt(confMatch[1] || confMatch[2]);

  // Detect overall grade
  let grade = null;
  const gradeMatch = analysisText.match(/[Oo]verall\s+[Gg]rade[:\s]+([A-D][+-]?)/);
  if (gradeMatch) grade = gradeMatch[1].toUpperCase();

  // Detect valuation
  let valuation = null;
  const valMatch = analysisText.match(/(?:Fair Market Value|Insurance.*Value|Valuation|Estimated.*[Vv]alue)[^:]*:\s*([€£$\d,\s–\-to]+(?:\([^)]+\))?)/);
  if (valMatch) valuation = valMatch[1].trim();

  const gradeWidths = {'A+':100,'A':92,'A-':85,'B+':78,'B':70,'B-':62,'C+':54,'C':46,'C-':38,'D':25};
  const gradeColors = {'A+':'#1a6b2e','A':'#1a6b2e','A-':'#2d8a3e','B+':'#c9922a','B':'#c9922a','B-':'#d4882a','C+':'#8b4a1e','C':'#8b3010','C-':'#8b2020','D':'#6b1010'};
  const confColor = confidence >= 75 ? '#1a6b2e' : confidence >= 50 ? '#c9922a' : '#8b2020';

  // Build sections HTML
  const sectionsHtml = sections.map(sec => {
    const isComparables = sec.title.match(/comparable|sales/i);
    const isValuation = sec.title.match(/^valuation/i);
    const isCondition = sec.title.match(/condition/i);

    let bodyHtml = '';

    if (isComparables) {
      // Render as table
      const rows = sec.lines.filter(l => l.match(/\d/) || l.match(/comparable/i)).map((l, i) => {
        const clean = l.replace(/^Comparable\s+\d+:\s*/i,'').replace(/\*\*/g,'');
        return `<tr class="${i%2===0?'row-even':'row-odd'}"><td>${clean}</td></tr>`;
      }).join('');
      bodyHtml = rows ? `<table class="comp-table"><thead><tr><th>Comparable sale</th></tr></thead><tbody>${rows}</tbody></table>` : '';
      // Add narrative lines
      const narrative = sec.lines.filter(l => !l.match(/^Comparable\s+\d+/i) && l.length > 20).map(l =>
        `<p>${l.replace(/\*\*/g,'')}</p>`
      ).join('');
      bodyHtml = narrative + bodyHtml;
    } else {
      bodyHtml = sec.lines.map(l => {
        l = l.replace(/\*\*/g,'');
        if (l.match(/^[-•]\s/)) return `<li>${l.replace(/^[-•]\s/,'')}</li>`;
        if (l.match(/Grade [A-D][+-]?/) && isCondition) {
          const g = (l.match(/Grade ([A-D][+-]?)/) || [])[1];
          return `<div class="grade-row"><span class="grade-label">${l}</span>${g && gradeWidths[g] ? `<div class="grade-track"><div class="grade-fill" style="width:${gradeWidths[g]}%;background:${gradeColors[g]||'#c9922a'};"></div></div>` : ''}</div>`;
        }
        return `<p>${l}</p>`;
      }).join('');
    }

    return `<div class="section">
      <div class="section-header"><h3>${sec.title.replace(/^\d+\.\s+/,'')}</h3></div>
      <div class="section-body">${bodyHtml}</div>
    </div>`;
  }).join('');

  // Photo grid
  const photoGrid = images.length ? `
    <div class="photo-grid">
      ${images.map((img, i) => `<div class="photo-cell"><img src="${img}" alt="Photo ${i+1}" loading="lazy"></div>`).join('')}
    </div>` : '';

  // Metric cards
  const metricCards = `
    <div class="metrics">
      ${confidence ? `<div class="metric-card">
        <div class="metric-label">Authenticity Confidence</div>
        <div class="metric-value">${confidence}%</div>
        <div class="metric-bar"><div class="metric-fill" style="width:${confidence}%;background:${confColor};"></div></div>
      </div>` : ''}
      ${grade ? `<div class="metric-card">
        <div class="metric-label">Condition Grade</div>
        <div class="metric-value">${grade}</div>
        <div class="metric-bar"><div class="metric-fill" style="width:${gradeWidths[grade]||50}%;background:${gradeColors[grade]||'#c9922a'};"></div></div>
      </div>` : ''}
      ${valuation ? `<div class="metric-card valuation-card">
        <div class="metric-label">Valuation</div>
        <div class="metric-value valuation-value">${valuation}</div>
      </div>` : ''}
    </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>3scouts Deep Analysis — ${report.listing_title}</title>
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=EB+Garamond:ital,wght@0,400;0,500;1,400&display=swap" rel="stylesheet">
  <style>
    :root {
      --gold: #c9922a; --gold-lt: #e8b84b; --ink: #2c1f0e; --ink-lt: #5a3e20;
      --parchment: #f5edd6; --parchment-dk: #e8d9b5; --sepia: #8b6344;
      --white: #fffdf7; --green: #1a4a2e;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--parchment); font-family: 'EB Garamond', serif; color: var(--ink); }

    /* NAV */
    nav { background: var(--ink); border-bottom: 2px solid var(--gold); padding: 0.75rem 1.5rem; display: flex; align-items: center; gap: 10px; }
    .nav-dots { display: flex; gap: 4px; }
    .nav-dots span { display: block; width: 9px; height: 9px; border-radius: 50%; }
    .nav-logo { font-family: 'Cinzel', serif; font-size: 1.1rem; font-weight: 700; color: var(--white); text-decoration: none; letter-spacing: 0.04em; }
    .nav-logo em { font-style: normal; font-size: 0.72rem; color: var(--gold); }
    .print-btn { margin-left: auto; background: transparent; border: 1px solid var(--gold); color: var(--gold); font-family: 'Cinzel', serif; font-size: 11px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; padding: 6px 14px; border-radius: 3px; cursor: pointer; }
    .print-btn:hover { background: var(--gold); color: var(--ink); }

    /* HEADER */
    .report-header { background: var(--ink); padding: 1.5rem; border-bottom: 2px solid var(--gold); }
    .report-tag { font-family: 'Cinzel', serif; font-size: 10px; font-weight: 700; letter-spacing: 2.5px; color: var(--gold); text-transform: uppercase; margin-bottom: 0.5rem; }
    .report-title { font-family: 'Cinzel', serif; font-size: 1.3rem; font-weight: 600; color: var(--white); line-height: 1.35; margin-bottom: 0.5rem; }
    .report-meta { font-size: 13px; color: rgba(255,255,255,0.45); display: flex; gap: 1.5rem; flex-wrap: wrap; }
    .report-meta strong { color: var(--gold-lt); }
    ${isEbay && report.listing_url ? '.view-ebay { display: inline-block; background: var(--gold); color: var(--ink); font-family: Cinzel, serif; font-size: 11px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; padding: 8px 18px; border-radius: 3px; text-decoration: none; margin-top: 0.75rem; }' : ''}

    /* PHOTOS */
    .photo-section { background: #1a0e05; padding: 1rem 1.5rem; border-bottom: 1px solid #3a2a15; }
    .photo-section-label { font-family: 'Cinzel', serif; font-size: 10px; font-weight: 700; letter-spacing: 2px; color: var(--gold); text-transform: uppercase; margin-bottom: 0.75rem; }
    .photo-grid { display: flex; gap: 10px; flex-wrap: wrap; }
    .photo-cell { flex: 0 0 auto; }
    .photo-cell img { width: 160px; height: 130px; object-fit: cover; border-radius: 3px; border: 1px solid #3a2a15; display: block; }

    /* METRICS */
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; padding: 1.25rem 1.5rem; background: var(--white); border-bottom: 1px solid var(--parchment-dk); }
    .metric-card { background: var(--parchment); border: 1px solid var(--parchment-dk); border-radius: 4px; padding: 1rem 1.25rem; }
    .metric-label { font-family: 'Cinzel', serif; font-size: 10px; font-weight: 700; letter-spacing: 1.5px; color: var(--sepia); text-transform: uppercase; margin-bottom: 0.4rem; }
    .metric-value { font-family: 'Cinzel', serif; font-size: 1.75rem; font-weight: 700; color: var(--ink); line-height: 1; margin-bottom: 0.6rem; }
    .metric-bar { background: var(--parchment-dk); border-radius: 3px; height: 6px; overflow: hidden; }
    .metric-fill { height: 100%; border-radius: 3px; transition: width 1s ease; }
    .valuation-card { background: var(--ink); border-color: var(--gold); }
    .valuation-card .metric-label { color: var(--gold); }
    .valuation-value { font-size: 1.3rem; color: var(--gold-lt) !important; }

    /* BRIEF REMINDER */
    .brief-bar { background: var(--parchment-dk); padding: 0.6rem 1.5rem; border-bottom: 1px solid #d0c0a0; }
    .brief-bar p { font-size: 13px; color: var(--sepia); }
    .brief-bar strong { color: var(--ink); }

    /* SECTIONS */
    .sections { max-width: 800px; margin: 0 auto; padding: 0 1.5rem 2rem; }
    .section { margin-top: 1.5rem; background: var(--white); border: 1px solid var(--parchment-dk); border-radius: 4px; overflow: hidden; }
    .section-header { background: var(--parchment); border-bottom: 2px solid var(--gold); padding: 0.6rem 1.25rem; }
    .section-header h3 { font-family: 'Cinzel', serif; font-size: 11px; font-weight: 700; letter-spacing: 1.5px; color: var(--gold); text-transform: uppercase; }
    .section-body { padding: 1.25rem; }
    .section-body p { font-size: 15px; color: var(--ink); line-height: 1.85; margin-bottom: 0.75rem; }
    .section-body p:last-child { margin-bottom: 0; }
    .section-body li { font-size: 14.5px; color: var(--ink-lt); line-height: 1.75; margin-bottom: 0.35rem; padding-left: 1.25rem; border-left: 2px solid var(--parchment-dk); list-style: none; }

    /* GRADE ROWS in condition */
    .grade-row { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
    .grade-label { font-size: 14px; color: var(--ink); min-width: 200px; flex-shrink: 0; }
    .grade-track { flex: 1; background: var(--parchment-dk); border-radius: 3px; height: 5px; overflow: hidden; }
    .grade-fill { height: 100%; border-radius: 3px; }

    /* COMPARABLES TABLE */
    .comp-table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; }
    .comp-table thead th { background: var(--gold); color: white; font-family: 'Cinzel', serif; font-size: 10px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; padding: 8px 12px; text-align: left; }
    .comp-table tbody td { padding: 9px 12px; font-size: 14px; color: var(--ink); line-height: 1.65; border-bottom: 1px solid var(--parchment-dk); }
    .row-even { background: var(--white); }
    .row-odd { background: var(--parchment); }

    /* FOOTER */
    .report-footer { background: var(--parchment-dk); padding: 1rem 1.5rem; text-align: center; margin-top: 2rem; }
    .report-footer p { font-size: 12px; color: var(--sepia); line-height: 1.7; }
    .report-footer a { color: var(--gold); text-decoration: none; }

    @media print {
      nav .print-btn { display: none; }
      .report-footer { margin-top: 1rem; }
    }
    @media (max-width: 600px) {
      .photo-cell img { width: 120px; height: 100px; }
      .metrics { grid-template-columns: 1fr 1fr; }
      .grade-label { min-width: 140px; font-size: 13px; }
    }
  </style>
</head>
<body>

  <nav>
    <a href="/" style="display:inline-flex;align-items:center;gap:10px;text-decoration:none;">
      <div class="nav-dots">
        <span style="background:var(--gold);"></span>
        <span style="background:var(--gold-lt);"></span>
        <span style="background:var(--gold);opacity:0.5;"></span>
      </div>
      <span class="nav-logo">3scouts<em>.com</em></span>
    </a>
    <button class="print-btn" onclick="window.print()">Print / Save PDF</button>
  </nav>

  <div class="report-header">
    <p class="report-tag">3scouts · ${isEbay ? 'Deep Analysis Report' : 'Valuation Report'}</p>
    <h1 class="report-title">${report.listing_title}</h1>
    <div class="report-meta">
      <span>${dateStr}</span>
      ${isEbay && report.listing_price ? `<span>Listed at <strong>${report.listing_price}</strong></span>` : ''}
      ${isEbay && report.listing_url ? `<span><a href="${report.listing_url}" style="color:var(--gold);" target="_blank">View on eBay →</a></span>` : ''}
    </div>
  </div>

  ${images.length ? `<div class="photo-section">
    <p class="photo-section-label">${isEbay ? 'Listing photos' : 'Submitted photos'}</p>
    ${photoGrid}
  </div>` : ''}

  ${metricCards}

  ${report.brief ? `<div class="brief-bar"><p><strong>Brief:</strong> ${report.brief}</p></div>` : ''}

  <div class="sections">
    ${sectionsHtml}
  </div>

  <div class="report-footer">
    <p>Without physically seeing and examining an item, no definitive appraisal can be made. This report is based on the photographs and description provided only. Always satisfy yourself on authenticity and condition before purchasing or selling.</p>
    <p style="margin-top:0.5rem;"><a href="https://www.3scouts.com">3scouts.com</a> &nbsp;·&nbsp; Powered by Anthropic &amp; Claude Advanced Vision</p>
  </div>

</body>
</html>`;
}

app.get('/report/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const client = await pool.connect();
    const result = await client.query(
      `SELECT da.*, s.name as subscriber_name, s.description as brief, s.category
       FROM deep_analyses da
       JOIN subscribers s ON da.subscriber_id = s.id
       WHERE da.id = $1`,
      [id]
    );
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
