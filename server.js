const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const path = require('path');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 3000;
const resend = new Resend(process.env.RESEND_API_KEY);

// ── EMAIL FUNCTIONS ──────────────────────────────────────────────

async function sendOwnerAlert(data) {
  const { name, email, plan, category, description, budget, negative, territories, frequency, images } = data;
  await resend.emails.send({
    from: 'i-Scout <scout@i-scout.eu>',
    reply_to: 'alan@aka.ie',
    to: 'alan@aka.ie',
    subject: `New i-Scout subscriber — ${name} — ${plan}`,
    html: `
      <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; background: #f5edd6; padding: 2rem; border-top: 4px solid #c9922a;">
        <h2 style="font-family: Georgia, serif; color: #2c1f0e; margin-bottom: 0.5rem;">New i-Scout Subscriber</h2>
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
            <td style="padding: 10px 0; color: #2c1f0e;">${images && images.length > 0 ? `${images.length} image(s) uploaded — check attachments` : 'None uploaded'}</td>
          </tr>
        </table>
        <div style="margin-top: 1.5rem; background: #2c1f0e; padding: 1rem 1.25rem; border-radius: 3px;">
          <p style="color: #e8b84b; font-size: 13px; margin: 0;">Action required: activate this subscriber's Scout and reply to confirm within 24 hours.</p>
        </div>
        <p style="font-size: 12px; color: #8b6344; margin-top: 1rem;">i-scout.eu · Powered by Anthropic & Claude Advanced Vision</p>
      </div>
    `
  });
}

async function sendWelcomeEmail(data) {
  const { name, email, plan, category } = data;
  await resend.emails.send({
    from: 'i-Scout <scout@i-scout.eu>',
    reply_to: 'alan@aka.ie',
    to: email,
    subject: `Your i-Scout is active — welcome aboard`,
    html: `
      <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; background: #f5edd6; padding: 2rem; border-top: 4px solid #c9922a;">
        <h2 style="font-family: Georgia, serif; color: #2c1f0e; margin-bottom: 0.25rem;">Your Scout is Active</h2>
        <p style="color: #c9922a; font-size: 13px; font-weight: bold; letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 1.5rem;">${plan}</p>
        <p style="color: #2c1f0e; font-size: 16px; line-height: 1.75; margin-bottom: 1rem;">Dear ${name},</p>
        <p style="color: #5a3e20; font-size: 15px; line-height: 1.8; margin-bottom: 1rem;">
          Your i-Scout subscription is confirmed and your Scout is now watching eBay around the clock for <strong style="color: #2c1f0e;">${category}</strong>.
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
          <p style="color: #e8b84b; font-size: 13px; margin: 0; letter-spacing: 0.04em;">i-scout.eu &nbsp;·&nbsp; Powered by Anthropic & Claude Advanced Vision</p>
        </div>
        <p style="font-size: 12px; color: #8b6344; margin-top: 1rem; line-height: 1.6;">
          You are receiving this email because you subscribed to i-Scout at i-scout.eu. 
          To manage your subscription, contact alan@aka.ie.
        </p>
      </div>
    `
  });
}

// ── WEBHOOK ──────────────────────────────────────────────────────

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const data = {
      name:        session.metadata?.name        || 'Subscriber',
      email:       session.customer_details?.email || '',
      plan:        session.metadata?.plan        || 'i-Scout',
      category:    session.metadata?.category    || 'Not specified',
      description: session.metadata?.description || '',
      budget:      session.metadata?.budget      || '',
      negative:    session.metadata?.negative    || '',
      territories: session.metadata?.territories || 'all',
      frequency:   session.metadata?.frequency   || 'immediate',
      images:      [],
    };

    console.log(`New subscriber: ${data.email} — ${data.plan} — ${data.category}`);

    try {
      await sendOwnerAlert(data);
      console.log('Owner alert sent');
    } catch (err) {
      console.error('Owner alert failed:', err.message);
    }

    try {
      await sendWelcomeEmail(data);
      console.log('Welcome email sent to', data.email);
    } catch (err) {
      console.error('Welcome email failed:', err.message);
    }
  }

  res.json({ received: true });
});

// ── MIDDLEWARE ───────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── CHECKOUT ─────────────────────────────────────────────────────

app.post('/create-checkout-session', async (req, res) => {
  const { plan, category, description, budget, name, email, negative, territories, frequency } = req.body;

  const priceMap = {
    trial:     process.env.STRIPE_PRICE_TRIAL,
    collector: process.env.STRIPE_PRICE_COLLECTOR,
    dealer:    process.env.STRIPE_PRICE_DEALER,
  };

  const priceId = priceMap[plan];
  if (!priceId) {
    return res.status(400).json({ error: 'Invalid plan selected' });
  }

  const planLabels = {
    trial:     'i-Scout Starter — €20/month',
    collector: 'i-Scout Collector — €45/month',
    dealer:    'i-Scout Dealer — €90/month',
  };

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
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
      success_url: `${process.env.SITE_URL || 'https://www.i-scout.eu'}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.SITE_URL || 'https://www.i-scout.eu'}/#brief`,
    });

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
      plan:     session.metadata?.plan     || 'i-Scout',
      email:    session.customer_details?.email || '',
      category: session.metadata?.category || '',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
  console.log(`i-Scout server running on port ${PORT}`);
});
