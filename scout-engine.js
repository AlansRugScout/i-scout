// ═══════════════════════════════════════════════════════════════
// 3scouts — Scout Engine
// Runs on a schedule, searches eBay per subscriber brief,
// sends alert emails, handles Deep Analysis requests
// ═══════════════════════════════════════════════════════════════

const { Pool } = require('pg');
const { Resend } = require('resend');
const Anthropic = require('@anthropic-ai/sdk');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const resend = new Resend(process.env.RESEND_API_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── DATABASE SETUP ───────────────────────────────────────────────

async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS subscribers (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        plan TEXT NOT NULL,
        category TEXT NOT NULL,
        description TEXT,
        budget TEXT,
        negative_keywords TEXT,
        territories TEXT DEFAULT 'all',
        frequency TEXT DEFAULT 'immediate',
        active BOOLEAN DEFAULT true,
        deep_analyses_used INTEGER DEFAULT 0,
        deep_analyses_limit INTEGER DEFAULT 20,
        created_at TIMESTAMP DEFAULT NOW(),
        last_alerted_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS seen_listings (
        id SERIAL PRIMARY KEY,
        subscriber_id INTEGER REFERENCES subscribers(id),
        ebay_item_id TEXT NOT NULL,
        seen_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(subscriber_id, ebay_item_id)
      );

      CREATE TABLE IF NOT EXISTS deep_analyses (
        id SERIAL PRIMARY KEY,
        subscriber_id INTEGER REFERENCES subscribers(id),
        ebay_item_id TEXT NOT NULL,
        listing_title TEXT,
        listing_url TEXT,
        listing_price TEXT,
        listing_image TEXT,
        analysis_text TEXT,
        requested_at TIMESTAMP DEFAULT NOW(),
        completed_at TIMESTAMP
      );
    `);
    console.log('Database initialised');
  } finally {
    client.release();
  }
}

// ── EBAY SEARCH ──────────────────────────────────────────────────

async function getEbayToken() {
  const credentials = Buffer.from(
    `${process.env.EBAY_APP_ID}:${process.env.EBAY_CERT_ID}`
  ).toString('base64');

  const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
  });

  const data = await response.json();
  if (!data.access_token) throw new Error('eBay token failed: ' + JSON.stringify(data));
  return data.access_token;
}

async function searchEbay(subscriber, token) {
  const keywords = buildSearchKeywords(subscriber);
  const params = new URLSearchParams({
    q: keywords,
    limit: '20',
    sort: 'newlyListed',
  });

  // Add price filter if budget specified
  if (subscriber.budget && subscriber.budget !== 'no limit') {
    const budgetNum = parseFloat(subscriber.budget.replace(/[^0-9.]/g, ''));
    if (!isNaN(budgetNum)) {
      params.append('filter', `price:[0..${budgetNum}],priceCurrency:EUR`);
    }
  }

  const response = await fetch(
    `https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': getEbayMarketplace(subscriber.territories),
        'Content-Type': 'application/json',
      },
    }
  );

  const data = await response.json();
  return data.itemSummaries || [];
}

function buildSearchKeywords(subscriber) {
  // Use description if provided, otherwise category
  const source = (subscriber.description && subscriber.description.length > 5)
    ? subscriber.description
    : subscriber.category;

  // Clean and trim to 100 chars
  return source
    .substring(0, 100)
    .replace(/[^\w\s'&-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getEbayMarketplace(territories) {
  if (!territories || territories === 'all') return 'EBAY_GB';
  const lower = territories.toLowerCase();
  if (lower.includes('us') || lower.includes('america')) return 'EBAY_US';
  if (lower.includes('au') || lower.includes('australia')) return 'EBAY_AU';
  if (lower.includes('de') || lower.includes('german')) return 'EBAY_DE';
  return 'EBAY_GB';
}

function isRelevantListing(listing, subscriber) {
  const title = (listing.title || '').toLowerCase();
  const negativeKeywords = (subscriber.negative_keywords || '')
    .split(',')
    .map(k => k.trim().toLowerCase())
    .filter(Boolean);

  // Check negative keywords
  for (const neg of negativeKeywords) {
    if (neg && title.includes(neg)) return false;
  }

  return true;
}

// ── ALERT EMAIL ──────────────────────────────────────────────────

async function sendAlertEmail(subscriber, listing) {
  const price = listing.price?.value
    ? `${listing.price.currency} ${listing.price.value}`
    : 'Price not listed';

  const imageUrl = listing.image?.imageUrl || null;
  const listingUrl = listing.itemWebUrl || `https://www.ebay.co.uk/itm/${listing.itemId}`;
  const deepAnalysisUrl = `${process.env.SITE_URL}/deep-analysis?subscriber=${encodeURIComponent(subscriber.email)}&item=${listing.itemId}`;

  await resend.emails.send({
    from: '3scouts <scout@3scouts.com>',
    reply_to: 'alan@aka.ie',
    to: subscriber.email,
    bcc: 'alan@aka.ie',
    subject: `3scouts found a match — ${listing.title?.substring(0, 60)}`,
    html: `
      <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; background: #f5edd6; padding: 0; border-top: 4px solid #c9922a;">

        <div style="background: #2c1f0e; padding: 1rem 1.5rem; border-bottom: 2px solid #c9922a;">
          <p style="font-family: Georgia, serif; font-size: 11px; letter-spacing: 2px; color: #c9922a; margin: 0 0 4px; text-transform: uppercase;">3scouts · New match found</p>
          <h2 style="font-family: Georgia, serif; font-size: 1.1rem; font-weight: 500; color: #fffdf7; margin: 0; line-height: 1.4;">${listing.title}</h2>
        </div>

        ${imageUrl ? `
        <div style="background: #e8d9b5; text-align: center; padding: 1rem;">
          <img src="${imageUrl}" alt="${listing.title}" style="max-width: 100%; max-height: 300px; object-fit: contain; border-radius: 2px;">
        </div>` : ''}

        <div style="padding: 1.25rem 1.5rem; background: #ffffff; border-bottom: 1px solid #e8d9b5;">
          <table style="width: 100%; border-collapse: collapse; font-size: 15px;">
            <tr style="border-bottom: 1px solid #e8d9b5;">
              <td style="padding: 8px 0; color: #8b6344; width: 140px;">Listed price</td>
              <td style="padding: 8px 0; color: #8b2020; font-family: Georgia, serif; font-size: 1.2rem; font-weight: bold;">${price}</td>
            </tr>
            <tr style="border-bottom: 1px solid #e8d9b5;">
              <td style="padding: 8px 0; color: #8b6344;">Category</td>
              <td style="padding: 8px 0; color: #2c1f0e;">${subscriber.category}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #8b6344;">Condition</td>
              <td style="padding: 8px 0; color: #2c1f0e;">${listing.condition || 'Not specified'}</td>
            </tr>
          </table>
        </div>

        <div style="padding: 1.25rem 1.5rem; background: #f5edd6;">
          <p style="font-size: 14px; color: #5a3e20; line-height: 1.7; margin: 0 0 1.25rem; font-style: italic;">
            This listing matches your 3scouts brief. View it on eBay to see full details, photos and seller information. Request a Deep Analysis for a full professional appraisal — authenticity, condition grading, comparable sales and our valuation recommendation.
          </p>
          <table style="width: 100%;">
            <tr>
              <td style="padding-right: 8px;">
                <a href="${listingUrl}" style="display: block; text-align: center; background: #2c1f0e; color: #e8b84b; font-family: Georgia, serif; font-size: 12px; font-weight: bold; letter-spacing: 1px; text-transform: uppercase; padding: 11px 16px; border-radius: 3px; text-decoration: none;">View on eBay →</a>
              </td>
              <td>
                <a href="${deepAnalysisUrl}" style="display: block; text-align: center; background: #c9922a; color: #2c1f0e; font-family: Georgia, serif; font-size: 12px; font-weight: bold; letter-spacing: 1px; text-transform: uppercase; padding: 11px 16px; border-radius: 3px; text-decoration: none;">Request Deep Analysis →</a>
              </td>
            </tr>
          </table>
        </div>

        <div style="background: #e8d9b5; padding: 0.75rem 1.5rem; border-top: 1px solid #b8945a;">
          <p style="font-size: 12px; color: #8b6344; margin: 0; line-height: 1.6;">
            Without physically seeing and examining an item, no definitive appraisal can be made. This alert is provided for research purposes only. You are protected by eBay's Money Back Guarantee if an item is not as described.
            &nbsp;·&nbsp; <a href="${process.env.SITE_URL}" style="color: #c9922a;">3scouts.com</a>
          </p>
        </div>

      </div>
    `,
  });
}

// ── DEEP ANALYSIS ────────────────────────────────────────────────

async function runDeepAnalysis(subscriberId, itemId) {
  const client = await pool.connect();
  try {
    // Get subscriber
    const subResult = await client.query(
      'SELECT * FROM subscribers WHERE id = $1', [subscriberId]
    );
    const subscriber = subResult.rows[0];
    if (!subscriber) throw new Error('Subscriber not found');

    // Check allowance
    if (subscriber.deep_analyses_used >= subscriber.deep_analyses_limit) {
      await sendDeepAnalysisLimitEmail(subscriber);
      return;
    }

    // Get eBay listing details
    const token = await getEbayToken();
    const response = await fetch(
      `https://api.ebay.com/buy/browse/v1/item/${itemId}`,
      { headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB' } }
    );
    const listing = await response.json();

    // Build image content for Claude
    const imageUrl = listing.image?.imageUrl;
    const additionalImages = (listing.additionalImages || []).slice(0, 3).map(i => i.imageUrl);
    const allImages = [imageUrl, ...additionalImages].filter(Boolean);

    // Fetch images as base64 for Claude
    const imageContents = [];
    for (const url of allImages.slice(0, 4)) {
      try {
        const imgResponse = await fetch(url);
        const buffer = await imgResponse.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        const contentType = imgResponse.headers.get('content-type') || 'image/jpeg';
        imageContents.push({
          type: 'image',
          source: { type: 'base64', media_type: contentType, data: base64 }
        });
      } catch (e) {
        console.error('Image fetch error:', e.message);
      }
    }

    // Run Claude Deep Analysis
    const prompt = `You are an expert antiques and collectables appraiser for 3scouts.com. 

A subscriber is interested in: ${subscriber.category}
Their brief: ${subscriber.description}

Please analyse this eBay listing and provide a structured Deep Analysis report covering:

1. AUTHENTICITY ASSESSMENT — Is this genuine? What evidence supports or challenges authenticity? Give a confidence percentage.
2. CONDITION ASSESSMENT — Grade each visible component. Give an overall grade (A/B/C/D) with explanation.
3. COMPARABLE SALES — What have similar items sold for recently? Give 3-5 comparable examples with prices and dates.
4. VALUATION — What is your fair value estimate range?
5. RECOMMENDATION — Is this worth pursuing at the listed price? Plain English, no jargon. Do NOT tell the subscriber to buy immediately or not to negotiate — simply give your assessment of the value.
6. ANY RED FLAGS — What should the buyer verify or be cautious about?

Listing title: ${listing.title}
Listed price: ${listing.price?.value} ${listing.price?.currency}
Condition: ${listing.condition}
Item location: ${listing.itemLocation?.country}
Seller feedback: ${listing.seller?.feedbackScore} (${listing.seller?.feedbackPercentage}%)
Description: ${(listing.description || '').substring(0, 1000)}

Please be specific, expert and honest. Without physically seeing the item, caveat your assessment appropriately.`;

    const messages = [
      {
        role: 'user',
        content: [
          ...imageContents,
          { type: 'text', text: prompt }
        ]
      }
    ];

    const claudeResponse = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 2000,
      messages,
    });

    const analysisText = claudeResponse.content[0].text;

    // Save to database
    await client.query(
      `INSERT INTO deep_analyses (subscriber_id, ebay_item_id, listing_title, listing_url, listing_price, listing_image, analysis_text, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [subscriberId, itemId, listing.title, listing.itemWebUrl, `${listing.price?.value} ${listing.price?.currency}`, imageUrl, analysisText]
    );

    // Update usage count
    await client.query(
      'UPDATE subscribers SET deep_analyses_used = deep_analyses_used + 1 WHERE id = $1',
      [subscriberId]
    );

    // Send Deep Analysis email
    await sendDeepAnalysisEmail(subscriber, listing, analysisText, imageUrl);

    console.log(`Deep Analysis completed for ${subscriber.email} — ${listing.title}`);

  } finally {
    client.release();
  }
}

async function sendDeepAnalysisEmail(subscriber, listing, analysisText, imageUrl) {
  const price = `${listing.price?.value} ${listing.price?.currency}`;

  // Convert analysis text to HTML paragraphs
  const analysisHtml = analysisText
    .split('\n')
    .filter(line => line.trim())
    .map(line => {
      if (line.match(/^\d+\.|^[A-Z\s]+—/)) {
        return `<h4 style="font-family:Georgia,serif;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#c9922a;margin:1.25rem 0 0.5rem;">${line}</h4>`;
      }
      return `<p style="font-size:15px;color:#5a3e20;line-height:1.8;margin:0 0 0.75rem;">${line}</p>`;
    })
    .join('');

  await resend.emails.send({
    from: '3scouts <scout@3scouts.com>',
    reply_to: 'alan@aka.ie',
    to: subscriber.email,
    bcc: 'alan@aka.ie',
    subject: `3scouts Deep Analysis — ${listing.title?.substring(0, 50)}`,
    html: `
      <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; background: #f5edd6; padding: 0; border-top: 4px solid #c9922a;">

        <div style="background: #2c1f0e; padding: 1rem 1.5rem; border-bottom: 2px solid #c9922a;">
          <p style="font-size: 11px; letter-spacing: 2px; color: #c9922a; margin: 0 0 4px; text-transform: uppercase;">3scouts · Deep Analysis Report</p>
          <h2 style="font-size: 1.1rem; font-weight: 500; color: #fffdf7; margin: 0; line-height: 1.4;">${listing.title}</h2>
          <p style="font-size: 13px; color: rgba(255,255,255,0.5); margin: 6px 0 0;">Listed at ${price} &nbsp;·&nbsp; ${new Date().toLocaleDateString('en-IE', { day: 'numeric', month: 'long', year: 'numeric' })}</p>
        </div>

        ${imageUrl ? `
        <div style="background: #e8d9b5; text-align: center; padding: 1rem;">
          <img src="${imageUrl}" alt="${listing.title}" style="max-width: 100%; max-height: 280px; object-fit: contain;">
        </div>` : ''}

        <div style="padding: 1.5rem; background: #ffffff; border-bottom: 1px solid #e8d9b5;">
          ${analysisHtml}
        </div>

        <div style="background: #e8d9b5; padding: 0.75rem 1.5rem;">
          <p style="font-size: 12px; color: #8b6344; margin: 0; line-height: 1.7;">
            Without physically seeing and examining an item, no definitive appraisal can be made. This Deep Analysis is based on available listing photographs and market data only. Always satisfy yourself on authenticity and condition before purchasing. You are protected by eBay's Money Back Guarantee if an item is not as described.
            &nbsp;·&nbsp; <a href="${process.env.SITE_URL}" style="color: #c9922a;">3scouts.com</a>
          </p>
        </div>

      </div>
    `,
  });
}

async function sendDeepAnalysisLimitEmail(subscriber) {
  await resend.emails.send({
    from: '3scouts <scout@3scouts.com>',
    reply_to: 'alan@aka.ie',
    to: subscriber.email,
    subject: '3scouts — Deep Analysis allowance reached',
    html: `
      <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; background: #f5edd6; padding: 2rem; border-top: 4px solid #c9922a;">
        <h2 style="font-family: Georgia, serif; color: #2c1f0e; margin-bottom: 1rem;">Deep Analysis allowance reached</h2>
        <p style="font-size: 15px; color: #5a3e20; line-height: 1.8; margin-bottom: 1rem;">
          Dear ${subscriber.name}, you have used all ${subscriber.deep_analyses_limit} Deep Analyses included in your current plan.
        </p>
        <p style="font-size: 15px; color: #5a3e20; line-height: 1.8; margin-bottom: 1.5rem;">
          To continue receiving Deep Analysis reports, you can top up your account at €2 per 10 analyses, or upgrade your plan for a higher monthly allowance.
        </p>
        <a href="mailto:alan@aka.ie?subject=Deep Analysis top-up" style="display: inline-block; background: #c9922a; color: #2c1f0e; font-family: Georgia, serif; font-size: 13px; font-weight: bold; letter-spacing: 1px; text-transform: uppercase; padding: 12px 24px; border-radius: 3px; text-decoration: none;">Request a top-up →</a>
        <p style="font-size: 12px; color: #8b6344; margin-top: 1.5rem;">3scouts.com · alan@aka.ie</p>
      </div>
    `,
  });
}

// ── SUBSCRIBER MANAGEMENT ─────────────────────────────────────────

async function upsertSubscriber(data) {
  const client = await pool.connect();
  try {
    const deepLimit = data.plan?.includes('Collector') ? 60 : data.plan?.includes('Dealer') ? 150 : 20;
    await client.query(
      `INSERT INTO subscribers (name, email, plan, category, description, budget, negative_keywords, territories, frequency, deep_analyses_limit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (email) DO UPDATE SET
         name = EXCLUDED.name,
         plan = EXCLUDED.plan,
         category = EXCLUDED.category,
         description = EXCLUDED.description,
         budget = EXCLUDED.budget,
         negative_keywords = EXCLUDED.negative_keywords,
         territories = EXCLUDED.territories,
         frequency = EXCLUDED.frequency,
         deep_analyses_limit = EXCLUDED.deep_analyses_limit,
         active = true`,
      [data.name, data.email, data.plan, data.category, data.description,
       data.budget, data.negative_keywords, data.territories, data.frequency, deepLimit]
    );
    console.log(`Subscriber upserted: ${data.email}`);
  } finally {
    client.release();
  }
}

async function deactivateSubscriber(email) {
  const client = await pool.connect();
  try {
    await client.query('UPDATE subscribers SET active = false WHERE email = $1', [email]);
    console.log(`Subscriber deactivated: ${email}`);
  } finally {
    client.release();
  }
}

// ── MAIN SCOUT RUNNER ─────────────────────────────────────────────

async function runScouts() {
  console.log(`Scout run started: ${new Date().toISOString()}`);
  const client = await pool.connect();
  try {
    const { rows: subscribers } = await client.query(
      'SELECT * FROM subscribers WHERE active = true'
    );
    console.log(`Running scouts for ${subscribers.length} active subscriber(s)`);

    let token;
    try {
      token = await getEbayToken();
    } catch (e) {
      console.error('eBay token error:', e.message);
      return;
    }

    for (const subscriber of subscribers) {
      try {
        if (!shouldAlertNow(subscriber)) {
          console.log(`Skipping ${subscriber.email} — not alert time yet`);
          continue;
        }

        console.log(`Searching eBay for: ${subscriber.email} — ${subscriber.category}`);
        const listings = await searchEbay(subscriber, token);
        console.log(`Found ${listings.length} listings for ${subscriber.email}`);

        let alertsSent = 0;
        for (const listing of listings) {
          // Skip if already seen
          const seenResult = await client.query(
            'SELECT id FROM seen_listings WHERE subscriber_id = $1 AND ebay_item_id = $2',
            [subscriber.id, listing.itemId]
          );
          if (seenResult.rows.length > 0) continue;

          // Check relevance
          if (!isRelevantListing(listing, subscriber)) {
            console.log(`Filtered out: ${listing.title}`);
            continue;
          }

          // Mark as seen
          await client.query(
            'INSERT INTO seen_listings (subscriber_id, ebay_item_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [subscriber.id, listing.itemId]
          );

          // Send alert
          await sendAlertEmail(subscriber, listing);
          alertsSent++;
          console.log(`Alert sent to ${subscriber.email}: ${listing.title}`);

          // Small delay between emails
          await new Promise(r => setTimeout(r, 500));
        }

        // Update last alerted time
        if (alertsSent > 0) {
          await client.query(
            'UPDATE subscribers SET last_alerted_at = NOW() WHERE id = $1',
            [subscriber.id]
          );
        }

        console.log(`${alertsSent} alert(s) sent to ${subscriber.email}`);

      } catch (err) {
        console.error(`Scout error for ${subscriber.email}:`, err.message);
      }
    }
  } finally {
    client.release();
  }
  console.log(`Scout run completed: ${new Date().toISOString()}`);
}

function shouldAlertNow(subscriber) {
  const freq = subscriber.frequency || 'immediate';
  if (freq === 'immediate') return true;

  // Use Irish time (Europe/Dublin) — handles GMT/IST automatically
  const now = new Date();
  const irishTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Dublin' }));
  const hour = irishTime.getHours();
  const day = irishTime.getDay();

  if (freq === 'morning') return hour === 8;
  if (freq === 'evening') return hour === 18;
  if (freq === 'twice') return hour === 8 || hour === 18;
  if (freq === 'weekly') return day === 1 && hour === 8; // Monday 8am Irish time

  return true;
}

module.exports = {
  initDatabase,
  runScouts,
  upsertSubscriber,
  deactivateSubscriber,
  runDeepAnalysis,
};
