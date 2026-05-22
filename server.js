const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const path = require('path');
 
const app = express();
const PORT = process.env.PORT || 3000;
 
// Webhook needs raw body — must come before express.json()
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
    const customerEmail = session.customer_details?.email;
    const planName = session.metadata?.plan;
    const category = session.metadata?.category;
    const description = session.metadata?.description;
 
    console.log(`New subscriber: ${customerEmail} — Plan: ${planName} — Category: ${category}`);
    // TODO: trigger Scout activation email to alan@aka.ie
    // TODO: send welcome email to customerEmail
  }
 
  res.json({ received: true });
});
 
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
 
// Create Stripe checkout session
app.post('/create-checkout-session', async (req, res) => {
  const { plan, category, description, budget, name, email } = req.body;
 
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
    trial:     'i-Scout Trial — €20/month',
    collector: 'i-Scout Collector — €45/month',
    dealer:    'i-Scout Dealer — €90/month',
  };
 
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: {
        plan: planLabels[plan],
        name: name || '',
        category: category || '',
        description: (description || '').substring(0, 500),
        budget: budget || '',
      },
      subscription_data: {
        metadata: {
          plan: planLabels[plan],
          name: name || '',
          category: category || '',
        },
      },
      success_url: `${process.env.SITE_URL || 'https://i-scout.eu'}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.SITE_URL || 'https://i-scout.eu'}/#brief`,
    });
 
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe session error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
 
// Success page data
app.get('/session-details', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'No session ID' });
 
  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    res.json({
      name: session.metadata?.name || 'Collector',
      plan: session.metadata?.plan || 'i-Scout',
      email: session.customer_details?.email || '',
      category: session.metadata?.category || '',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// Serve success page explicitly
app.get('/success', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'success.html'));
});
 
// Serve all HTML files
app.get('*', (req, res) => {
  const file = req.path === '/' ? 'index.html' : req.path.replace(/^\//, '');
  const filePath = path.join(__dirname, 'public', file);
  res.sendFile(filePath, err => {
    if (err) res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });
});
 
 
app.listen(PORT, () => {
  console.log(`i-Scout server running on port ${PORT}`);
});
