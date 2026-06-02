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
  const keywords = await buildSearchKeywords(subscriber);
  console.log(`Search keywords for ${subscriber.email}: "${keywords}"`);

  const marketplace = getEbayMarketplace(subscriber.territories);
  const isWorldwide = !subscriber.territories || subscriber.territories === 'all';

  // Parse territory list — could be comma-separated marketplace IDs or 'all'
  let marketplaces;
  if (isWorldwide) {
    marketplaces = ['EBAY_GB', 'EBAY_IE', 'EBAY_US', 'EBAY_AU', 'EBAY_CA', 'EBAY_DE', 'EBAY_FR', 'EBAY_IT', 'EBAY_ES'];
  } else if (subscriber.territories.includes('EBAY_')) {
    // New format — comma-separated marketplace IDs
    marketplaces = subscriber.territories.split(',').map(t => t.trim()).filter(Boolean);
  } else {
    // Legacy format — use getEbayMarketplace
    marketplaces = [getEbayMarketplace(subscriber.territories)];
  }

  const allListings = [];
  const seenIds = new Set();

  for (const market of marketplaces) {
    console.log(`eBay marketplace: ${market}`);
    const params = new URLSearchParams({
      q: keywords,
      limit: '25',
      sort: 'newlyListed',
    });

    if (subscriber.budget && subscriber.budget !== 'no limit' && subscriber.budget !== '') {
      const budgetNum = parseFloat(subscriber.budget.replace(/[^0-9.]/g, ''));
      if (!isNaN(budgetNum) && budgetNum > 0) {
        // Don't lock to EUR — just use as a rough upper price guide
        params.append('filter', `price:[0..${budgetNum}]`);
      }
    }

    try {
      const response = await fetch(
        `https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-EBAY-C-MARKETPLACE-ID': market,
            'Content-Type': 'application/json',
          },
        }
      );

      const data = await response.json();
      if (data.errors) {
        console.error(`eBay error on ${market}:`, JSON.stringify(data.errors));
        continue;
      }

      const items = data.itemSummaries || [];
      // Deduplicate across marketplaces
      for (const item of items) {
        if (!seenIds.has(item.itemId)) {
          seenIds.add(item.itemId);
          allListings.push(item);
        }
      }
      console.log(`${market}: ${items.length} listings`);
    } catch (err) {
      console.error(`Search error on ${market}:`, err.message);
    }
  }

  console.log(`Total listings found for ${subscriber.email}: ${allListings.length}`);
  return allListings;
}

async function buildSearchKeywords(subscriber) {
  try {
    const prompt = `You are an eBay search expert. Convert this collector's description into the best possible eBay search keywords.

Collector's description: "${subscriber.description || subscriber.category}"

Rules:
- Return ONLY the search keywords, nothing else
- Maximum 4 words
- Use ONLY the most essential identifying terms — make and model or make and type
- Do NOT add descriptive words like "antique", "vintage", "rare", "original" unless the collector specifically used them
- Do NOT add condition words
- Do NOT add words about accessories like "box", "papers", "bracelet"
- Keep it as simple as possible — what would a seller put in their listing title?

Examples:
"Squale 1521 or 1545 Blue Dial Dive Watch on Stainless Steel Bracelet with box and papers" → "Squale 1521 1545 blue"
"Bechstein boudoir grand 1890s" → "Bechstein grand piano"
"1960s Irish rugby International programmes autographed" → "Ireland rugby programme signed"
"porcelain ceramic pig piglet figurine shelf collectable" → "pig figurine ceramic"
"Mark O Neill paintings" → "Mark O Neill painting"
"Persian rug antique tribal wool hand knotted" → "Persian rug antique"

Return ONLY the keywords, no explanation, no punctuation.`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 50,
      messages: [{ role: 'user', content: prompt }],
    });

    const keywords = response.content[0].text.trim().replace(/['"]/g, '');
    console.log(`Smart keywords for "${subscriber.description?.substring(0, 40)}": "${keywords}"`);
    return keywords;
  } catch (err) {
    console.error('Keyword extraction error:', err.message);
    // Fallback to simple extraction
    const source = subscriber.description || subscriber.category;
    return source.replace(/[^\w\s'&-]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(w => w.length > 2).slice(0, 5).join(' ');
  }
}

function getEbayMarketplace(territories) {

  if (!territories || territories === 'all') return 'EBAY_US';
  const lower = territories.toLowerCase();
  if (lower.includes('uk') || lower.includes('britain') || lower.includes('ireland')) return 'EBAY_GB';
  if (lower.includes('au') || lower.includes('australia')) return 'EBAY_AU';
  if (lower.includes('de') || lower.includes('german')) return 'EBAY_DE';
  if (lower.includes('us') || lower.includes('america')) return 'EBAY_US';
  return 'EBAY_US';
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

// ── QUICK ESTIMATE ───────────────────────────────────────────────

async function getQuickEstimate(listing, subscriber) {
  try {
    const price = listing.price?.value
      ? `${listing.price.currency} ${listing.price.value}`
      : 'Price not listed';

    const prompt = `You are a collectables expert for 3scouts. Assess this eBay listing briefly.

Item: ${listing.title}
Listed price: ${price}
Condition: ${listing.condition || 'Not specified'}
Subscriber is looking for: ${subscriber.description || subscriber.category}

Respond in exactly this JSON format with no other text:
{
  "estimate": "£X–£Y" or "€X–€Y" or "$X–$Y" (realistic value range based on the item),
  "assessment": "One sentence, max 15 words, plain English assessment of whether this looks worth pursuing"
}

Be honest and specific. If you cannot assess from the title alone, give a general range based on similar items.`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text.trim();
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error('Quick estimate error:', err.message);
    return { estimate: null, assessment: null };
  }
}

// ── RELEVANCE RANKING ────────────────────────────────────────────

async function rankListings(listings, subscriber) {
  try {
    const listingsSummary = listings.map((l, i) => 
      `${i}: ${l.title} — ${l.price?.value} ${l.price?.currency || ''} — ${l.condition || ''}`
    ).join('\n');

    const prompt = `You are a collectables expert. A subscriber is looking for: "${subscriber.description}"

Here are ${listings.length} eBay listings. Return the indices of the 8 most relevant ones, ranked best first.

Listings:
${listingsSummary}

Reply with ONLY 8 comma-separated numbers (the indices), nothing else. Example: 3,7,1,12,0,5,9,2`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 50,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text.trim();
    const indices = text.split(',')
      .map(n => parseInt(n.trim()))
      .filter(n => !isNaN(n) && n >= 0 && n < listings.length)
      .slice(0, 8);

    console.log(`Ranked indices: ${indices.join(',')}`);
    return indices.map(i => listings[i]);
  } catch (err) {
    console.error('Ranking error:', err.message);
    // Fallback — just return first 8
    return listings.slice(0, 8);
  }
}

async function sendDigestEmail(subscriber, listings) {
  const count = listings.length;
  const subject = count === 1
    ? `3scouts found 1 match — ${listings[0].title?.substring(0, 50)}`
    : `3scouts found ${count} new matches for you`;

  // Get quick estimates in parallel
  const estimates = await Promise.all(
    listings.map(listing => getQuickEstimate(listing, subscriber))
  );

  const listingBlocks = listings.map((listing, index) => {
    const price = listing.price?.value
      ? `${listing.price.currency} ${listing.price.value}`
      : 'Price not listed';
    const imageUrl = listing.image?.imageUrl;
    const listingUrl = listing.itemWebUrl || `https://www.ebay.co.uk/itm/${listing.itemId}`;
    const deepAnalysisUrl = `${process.env.SITE_URL}/deep-analysis?subscriber=${encodeURIComponent(subscriber.email)}&item=${listing.itemId}`;
    const est = estimates[index] || {};

    return `
      <div style="background:#ffffff;border:1px solid #e8d9b5;border-radius:3px;margin-bottom:1.25rem;overflow:hidden;">
        <div style="background:#f5edd6;padding:0.5rem 1.25rem;border-bottom:1px solid #e8d9b5;">
          <span style="font-family:Georgia,serif;font-size:11px;letter-spacing:2px;color:#c9922a;text-transform:uppercase;">Match ${index + 1} of ${count}</span>
          ${listing.condition ? `<span style="font-family:Georgia,serif;font-size:11px;color:#8b6344;float:right;">${listing.condition}</span>` : ''}
        </div>
        <table style="width:100%;border-collapse:collapse;">
          <tr>
            ${imageUrl ? `<td style="width:110px;padding:0.75rem;vertical-align:top;"><img src="${imageUrl}" alt="" style="width:100px;height:100px;object-fit:cover;border-radius:2px;border:1px solid #e8d9b5;display:block;"></td>` : ''}
            <td style="padding:0.75rem;vertical-align:top;">
              <p style="font-family:Georgia,serif;font-size:14.5px;font-weight:500;color:#2c1f0e;margin:0 0 0.5rem;line-height:1.4;">${listing.title}</p>
              <table style="width:100%;border-collapse:collapse;margin-bottom:0.6rem;">
                <tr>
                  <td style="padding:4px 8px 4px 0;vertical-align:top;width:48%;">
                    <span style="font-family:Georgia,serif;font-size:10px;letter-spacing:1px;color:#8b6344;text-transform:uppercase;display:block;margin-bottom:2px;">Listed price</span>
                    <span style="font-family:Georgia,serif;font-size:1.1rem;font-weight:700;color:#8b2020;">${price}</span>
                  </td>
                  ${est.estimate ? `<td style="padding:4px 0 4px 8px;vertical-align:top;border-left:2px solid #e8d9b5;padding-left:10px;">
                    <span style="font-family:Georgia,serif;font-size:10px;letter-spacing:1px;color:#8b6344;text-transform:uppercase;display:block;margin-bottom:2px;">Our estimate</span>
                    <span style="font-family:Georgia,serif;font-size:1.1rem;font-weight:700;color:#1a4a2e;">${est.estimate}</span>
                  </td>` : ''}
                </tr>
              </table>
              ${est.assessment ? `<div style="background:#f5edd6;border-left:3px solid #c9922a;padding:6px 10px;margin-bottom:0.75rem;font-family:Georgia,serif;font-size:13px;color:#5a3e20;line-height:1.6;font-style:italic;">"${est.assessment}"</div>` : ''}
              <table style="border-collapse:collapse;">
                <tr>
                  <td style="padding-right:8px;"><a href="${listingUrl}" style="display:inline-block;background:#2c1f0e;color:#e8b84b;font-family:Georgia,serif;font-size:13px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;padding:10px 16px;border-radius:3px;text-decoration:none;white-space:nowrap;">View on eBay →</a></td>
                  <td><a href="${deepAnalysisUrl}" style="display:inline-block;background:#c9922a;color:#2c1f0e;font-family:Georgia,serif;font-size:13px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;padding:10px 16px;border-radius:3px;text-decoration:none;white-space:nowrap;">Deep Analysis →</a></td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </div>
    `;
  }).join('');

  await resend.emails.send({
    from: '3scouts <scout@3scouts.com>',
    reply_to: 'alan@3scouts.com',
    to: subscriber.email,
    bcc: 'alan@aka.ie',
    subject,
    html: `
      <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;background:#f5edd6;padding:0;border-top:4px solid #c9922a;">
        <div style="background:#2c1f0e;padding:1rem 1.5rem;border-bottom:2px solid #c9922a;">
          <p style="font-size:11px;letter-spacing:2px;color:#c9922a;margin:0 0 4px;text-transform:uppercase;">3scouts · Your matches</p>
          <h2 style="font-size:1.1rem;font-weight:500;color:#fffdf7;margin:0;line-height:1.4;">${count === 1 ? 'Your Scout found a match' : `Your Scout found ${count} new matches`}</h2>
          <p style="font-size:13px;color:rgba(255,255,255,0.5);margin:5px 0 0;">Watching for: ${subscriber.description || subscriber.category}</p>
        </div>
        <div style="background:#ffffff;border-left:4px solid #c9922a;padding:0.75rem 1.25rem;margin:0 0 1rem;font-family:Georgia,serif;font-size:14px;color:#5a3e20;line-height:1.7;">
          See something promising? Click <strong style="color:#2c1f0e;">Deep Analysis</strong> for a full professional appraisal — authenticity, condition, comparable sales and our valuation. Usually back to you within the hour.
        </div>
        <div style="padding:1.25rem 1.25rem 0.5rem;">${listingBlocks}</div>
        <div style="padding:0.75rem 1.5rem 1rem;border-top:1px solid #e8d9b5;">
          <p style="font-size:13px;color:#8b6344;line-height:1.7;margin:0;">
            Click <strong style="color:#2c1f0e;">Deep Analysis</strong> on any item for a full professional appraisal.
            &nbsp;·&nbsp; To update your brief, email <a href="mailto:alan@3scouts.com" style="color:#c9922a;">alan@3scouts.com</a>
            &nbsp;·&nbsp; <a href="https://billing.stripe.com/p/login/28E14g5sbcDi5nOc9b9Ve00" style="color:#8b6344;">Manage subscription</a>
          </p>
        </div>
        <div style="background:#e8d9b5;padding:0.75rem 1.5rem;">
          <p style="font-size:12px;color:#8b6344;margin:0;line-height:1.6;">
            Without physically seeing an item, no definitive appraisal can be made. This alert is for research purposes only. eBay Money Back Guarantee applies if an item is not as described.
            &nbsp;·&nbsp; <a href="${process.env.SITE_URL}" style="color:#c9922a;">3scouts.com</a>
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

Please be specific, expert and honest. Without physically seeing the item, caveat your assessment appropriately. Do not use markdown formatting — no #, ##, **, or --- symbols. Write in plain prose with numbered section headings.`;

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

  // Convert analysis text to rich HTML
  const analysisHtml = analysisText
    .split('\n')
    .filter(line => line.trim())
    .map(line => {
      if (line.match(/^\d+\.|^[A-Z\s]+—|^[A-Z\s]+:/)) {
        return `<div style="background:#f5edd6;border-left:4px solid #c9922a;padding:8px 12px;margin:1.25rem 0 0.5rem;"><h4 style="font-family:Georgia,serif;font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#c9922a;margin:0;">${line}</h4></div>`;
      }
      if (line.startsWith('**') || line.startsWith('•') || line.startsWith('-')) {
        return `<p style="font-size:14.5px;color:#5a3e20;line-height:1.8;margin:0 0 0.4rem;padding-left:1rem;border-left:2px solid #e8d9b5;">${line.replace(/^[\*\-•]\s*/, '')}</p>`;
      }
      return `<p style="font-size:15px;color:#2c1f0e;line-height:1.85;margin:0 0 0.6rem;">${line}</p>`;
    })
    .join('');

  await resend.emails.send({
    from: '3scouts <scout@3scouts.com>',
    reply_to: 'alan@3scouts.com',
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
    reply_to: 'alan@3scouts.com',
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
        <a href="mailto:alan@3scouts.com?subject=Deep Analysis top-up" style="display: inline-block; background: #c9922a; color: #2c1f0e; font-family: Georgia, serif; font-size: 13px; font-weight: bold; letter-spacing: 1px; text-transform: uppercase; padding: 12px 24px; border-radius: 3px; text-decoration: none;">Request a top-up →</a>
        <p style="font-size: 12px; color: #8b6344; margin-top: 1.5rem;">3scouts.com · alan@3scouts.com</p>
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
    // Clean up seen listings older than 30 days
    const cleaned = await client.query(
      'DELETE FROM seen_listings WHERE seen_at < NOW() - INTERVAL \'30 days\''
    );
    if (cleaned.rowCount > 0) {
      console.log(`Cleaned up ${cleaned.rowCount} old seen listings`);
    }
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

        console.log(`Searching eBay for: ${subscriber.email} — ${subscriber.description || subscriber.category}`);
        const listings = await searchEbay(subscriber, token);
        console.log(`Found ${listings.length} listings for ${subscriber.email}`);

        const newMatches = [];
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

          newMatches.push(listing);
        }

        // Rank and cap matches before sending digest
        let digestMatches = newMatches;
        if (newMatches.length > 8) {
          console.log(`Ranking ${newMatches.length} matches for ${subscriber.email} — selecting top 8`);
          digestMatches = await rankListings(newMatches, subscriber);
        }

        // Send single digest email if any new matches
        if (digestMatches.length > 0) {
          await sendDigestEmail(subscriber, digestMatches);
          await client.query(
            'UPDATE subscribers SET last_alerted_at = NOW() WHERE id = $1',
            [subscriber.id]
          );
          console.log(`Digest sent to ${subscriber.email}: ${digestMatches.length} match(es) (from ${newMatches.length} found)`);
        } else {
          console.log(`0 new matches for ${subscriber.email}`);
        }

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

// ── DEEP ANALYSIS FROM DESCRIPTION (for Value this Item) ──────────

async function runDeepAnalysisFromDescription(subscriberId, description, imageDataUrls) {
  const client = await pool.connect();
  try {
    const subResult = await client.query('SELECT * FROM subscribers WHERE id = $1', [subscriberId]);
    const subscriber = subResult.rows[0];
    if (!subscriber) throw new Error('Subscriber not found');

    if (subscriber.deep_analyses_used >= subscriber.deep_analyses_limit) {
      await sendDeepAnalysisLimitEmail(subscriber);
      return;
    }

    // Build image content for Claude from base64 data URLs
    console.log(`runDeepAnalysis: received ${imageDataUrls.length} image(s) for ${subscriber.email}`);
    const imageContents = [];
    for (const dataUrl of imageDataUrls.slice(0, 5)) {
      const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (matches) {
        console.log(`  Image: mime=${matches[1]} size=${matches[2].length} chars`);
        imageContents.push({
          type: 'image',
          source: { type: 'base64', media_type: matches[1], data: matches[2] }
        });
      } else {
        console.log(`  Image: failed to parse data URL (length=${dataUrl?.length})`);
      }
    }
    console.log(`runDeepAnalysis: sending ${imageContents.length} image(s) to Claude`);

    const prompt = `You are an expert antiques and collectables appraiser for 3scouts.com. The service is based in Ireland and primarily serves European and UK collectors.

A subscriber has submitted photos of an item they want appraised and valued.

Their description: ${description}

Please provide a full Deep Analysis covering:
1. ITEM IDENTIFICATION — What is this item? Who made it? When was it made?
2. AUTHENTICITY ASSESSMENT — Is this genuine? What evidence supports or challenges authenticity? Give a confidence percentage.
3. CONDITION ASSESSMENT — Grade each visible aspect. Give an overall grade (A/B/C/D) with explanation.
4. COMPARABLE SALES — What have similar items sold for recently? Give 3-5 comparable examples with prices and dates if possible. Use EUR (€) or GBP (£) for valuations.
5. VALUATION — What is your fair value estimate range? Express in EUR (€) or GBP (£).
6. RECOMMENDATION — Is this worth pursuing or keeping at the implied value? Plain English, no jargon.
7. ANY RED FLAGS — What should the owner verify or be cautious about?

Be specific, expert and honest. Note that without physically examining the item, your assessment is based on the photographs provided. Do not use markdown formatting — no #, ##, **, or --- symbols. Write in plain prose with clear section headings followed by a colon.`;

    const messages = [{
      role: 'user',
      content: [
        ...imageContents,
        { type: 'text', text: prompt }
      ]
    }];

    const claudeResponse = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 2000,
      messages,
    });

    const analysisText = claudeResponse.content[0].text;

    // Save to database
    await client.query(
      `INSERT INTO deep_analyses (subscriber_id, ebay_item_id, listing_title, analysis_text, completed_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [subscriberId, 'valuation-' + Date.now(), description.substring(0, 100), analysisText]
    );

    // Update usage count
    await client.query(
      'UPDATE subscribers SET deep_analyses_used = deep_analyses_used + 1 WHERE id = $1',
      [subscriberId]
    );

    // Send branded appraisal email
    await sendValuationEmail(subscriber, description, analysisText);

    // Send follow-up subscription nudge after 2 hours if not already a subscriber
    setTimeout(async () => {
      try {
        await sendValuationFollowUp(subscriber.email, subscriber.name);
      } catch(e) {
        console.error('Follow-up email error:', e.message);
      }
    }, 2 * 60 * 60 * 1000);

    console.log(`Valuation completed for ${subscriber.email}`);
  } finally {
    client.release();
  }
}

async function sendValuationEmail(subscriber, description, analysisText) {
  const analysisHtml = analysisText
    .split('\n')
    .filter(line => line.trim() && line.trim() !== '---')
    .map(line => {
      // Strip markdown heading prefixes # ## ###
      line = line.replace(/^#{1,3}\s+/, '');

      // Section headers — numbered like "1. ITEM IDENTIFICATION"
      if (line.match(/^\d+\.\s+[A-Z]/)) {
        return `<div style="background:#f5edd6;border-left:4px solid #c9922a;padding:8px 14px;margin:1.5rem 0 0.6rem;"><h4 style="font-family:Georgia,serif;font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#c9922a;margin:0;">${line}</h4></div>`;
      }

      // Sub-headings that end with colon e.g. "The Maker:"
      if (line.match(/^[A-Z][^.!?]*:$/) || line.match(/^[A-Z][^.!?]*:\s*$/)) {
        const clean = line.replace(/\*\*/g, '').replace(/:$/, '');
        return `<p style="font-family:Georgia,serif;font-size:15px;font-weight:700;color:#2c1f0e;margin:1rem 0 0.3rem;">${clean}</p>`;
      }

      // Bullet points
      if (line.match(/^[-•*]\s/)) {
        const clean = line.replace(/^[-•*]\s/, '').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        return `<p style="font-size:14.5px;color:#5a3e20;line-height:1.8;margin:0 0 0.35rem;padding-left:1.25rem;border-left:2px solid #e8d9b5;">${clean}</p>`;
      }

      // Convert **bold** inline
      line = line.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

      // ALL CAPS lines are sub-headings
      if (line.match(/^[A-Z\s]{6,}$/) && line.trim().length > 5) {
        return `<div style="background:#f5edd6;border-left:4px solid #c9922a;padding:8px 14px;margin:1.5rem 0 0.6rem;"><h4 style="font-family:Georgia,serif;font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#c9922a;margin:0;">${line}</h4></div>`;
      }

      return `<p style="font-size:15px;color:#2c1f0e;line-height:1.85;margin:0 0 0.6rem;">${line}</p>`;
    })
    .join('');

  const textContent = analysisText;

  await resend.emails.send({
    from: '3scouts <scout@3scouts.com>',
    reply_to: 'alan@3scouts.com',
    to: subscriber.email,
    bcc: 'alan@aka.ie',
    subject: `3scouts Valuation Report — ${description.substring(0, 50)}`,
    text: `3scouts Valuation Report\n\n${description}\n\n${new Date().toLocaleDateString('en-IE', { day: 'numeric', month: 'long', year: 'numeric' })}\n\n${textContent}\n\n---\nWithout physically seeing and examining an item, no definitive appraisal can be made. This valuation is based on the photographs and description provided only.\n\n3scouts.com · alan@3scouts.com`,
    html: `
      <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;background:#f5edd6;padding:0;border-top:4px solid #c9922a;">

        <div style="background:#2c1f0e;padding:1rem 1.5rem;border-bottom:2px solid #c9922a;">
          <p style="font-size:11px;letter-spacing:2px;color:#c9922a;margin:0 0 4px;text-transform:uppercase;">3scouts · Valuation Report</p>
          <h2 style="font-size:1.1rem;font-weight:500;color:#fffdf7;margin:0;line-height:1.4;">${description.substring(0, 80)}</h2>
          <p style="font-size:13px;color:rgba(255,255,255,0.5);margin:5px 0 0;">${new Date().toLocaleDateString('en-IE', { day: 'numeric', month: 'long', year: 'numeric' })}</p>
        </div>

        <div style="padding:1.5rem;background:#ffffff;border-bottom:1px solid #e8d9b5;">
          ${analysisHtml}
        </div>

        <div style="background:#e8d9b5;padding:0.75rem 1.5rem;">
          <p style="font-size:12px;color:#8b6344;margin:0;line-height:1.7;">
            Without physically seeing and examining an item, no definitive appraisal can be made. This valuation is based on the photographs and description provided only. Always satisfy yourself on authenticity and condition before purchasing or selling.
            &nbsp;·&nbsp; <a href="https://www.3scouts.com" style="color:#c9922a;">3scouts.com</a>
          </p>
        </div>
      </div>
    `,
  });
}

async function sendValuationFollowUp(email, name) {
  await resend.emails.send({
    from: '3scouts <scout@3scouts.com>',
    reply_to: 'alan@3scouts.com',
    to: email,
    subject: 'Did you enjoy your 3scouts appraisal?',
    html: `
      <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;background:#f5edd6;padding:0;border-top:4px solid #c9922a;">
        <div style="background:#2c1f0e;padding:1rem 1.5rem;border-bottom:2px solid #c9922a;">
          <p style="font-size:11px;letter-spacing:2px;color:#c9922a;margin:0 0 4px;text-transform:uppercase;">3scouts · A note from us</p>
          <h2 style="font-size:1.1rem;font-weight:500;color:#fffdf7;margin:0;">Hope you enjoyed your appraisal, ${name}</h2>
        </div>
        <div style="padding:1.5rem;background:#ffffff;border-bottom:1px solid #e8d9b5;">
          <p style="font-size:15px;color:#2c1f0e;line-height:1.85;margin:0 0 1rem;">We hope your 3scouts valuation report was useful. If you'd like us to keep working for you — watching eBay around the clock for whatever you collect, alerting you the moment a genuine find appears with a full professional appraisal — we'd love to have you as a subscriber.</p>
          <p style="font-size:15px;color:#2c1f0e;line-height:1.85;margin:0 0 1.5rem;">Starting at just <strong>€20 a month</strong>. No contracts, no commitments, cancel anytime.</p>
          <a href="${process.env.SITE_URL}/#brief" style="display:inline-block;background:#c9922a;color:#2c1f0e;font-family:Georgia,serif;font-size:13px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;padding:12px 24px;border-radius:3px;text-decoration:none;white-space:nowrap;">Start my subscription →</a>
        </div>
        <div style="background:#e8d9b5;padding:0.75rem 1.5rem;">
          <p style="font-size:12px;color:#8b6344;margin:0;line-height:1.6;">
            3scouts.com · <a href="mailto:alan@3scouts.com" style="color:#c9922a;">alan@3scouts.com</a> · No contracts · Cancel anytime
          </p>
        </div>
      </div>
    `,
  });
}

module.exports = {
  initDatabase,
  runScouts,
  upsertSubscriber,
  deactivateSubscriber,
  runDeepAnalysis,
  runDeepAnalysisFromDescription,
};
