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
    await client.query(`
      CREATE TABLE IF NOT EXISTS follow_up_queue (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        name VARCHAR(255),
        send_after TIMESTAMPTZ NOT NULL,
        sent BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Add access_token to subscribers if not present
    await client.query(`
      ALTER TABLE subscribers
        ADD COLUMN IF NOT EXISTS access_token VARCHAR(32)
    `);
    // Generate tokens for any subscribers that don't have one
    await client.query(`
      UPDATE subscribers
      SET access_token = substr(md5(random()::text || id::text), 1, 32)
      WHERE access_token IS NULL
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
  "estimate": "£X–£Y" or "€X–€Y" or "$X–$Y" (realistic value range in EUR or GBP),
  "assessment": "One sentence, max 15 words, plain English — focus on value and condition only, never say not relevant"
}

Be honest and specific. Focus only on whether the price looks fair for what it is.`;

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

Here are ${listings.length} eBay listings. Return ONLY the indices of relevant listings, up to 10, ranked best first. Do NOT include listings that are clearly irrelevant — omit them entirely.

Listings:
${listingsSummary}

Reply with ONLY comma-separated numbers (the indices of relevant listings only), nothing else. If none are relevant return: none`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 50,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text.trim();
    const indices = text.split(',')
      .map(n => parseInt(n.trim()))
      .filter(n => !isNaN(n) && n >= 0 && n < listings.length)
      .slice(0, 10);

    console.log(`Ranked indices: ${indices.join(',')}`);
    return indices.map(i => listings[i]);
  } catch (err) {
    console.error('Ranking error:', err.message);
    // Fallback — just return first 8
    return listings.slice(0, 10);
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
    bcc: ['alan@aka.ie', 'akeane60@gmail.com'],
    subject,
    html: `
      <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;background:#f5edd6;padding:0;border-top:4px solid #c9922a;">
        <div style="background:#2c1f0e;padding:1rem 1.5rem;border-bottom:2px solid #c9922a;">
          <p style="font-size:11px;letter-spacing:2px;color:#c9922a;margin:0 0 4px;text-transform:uppercase;">3scouts · Your matches</p>
          <h2 style="font-size:1.1rem;font-weight:500;color:#fffdf7;margin:0;line-height:1.4;">${count === 1 ? 'Your Scout found a match' : `Your Scout found ${count} new matches`}</h2>
          <p style="font-size:13px;color:rgba(255,255,255,0.5);margin:5px 0 0;">Watching for: ${subscriber.description || subscriber.category}</p>
        </div>
        <div style="background:#ffffff;border-left:4px solid #c9922a;padding:0.75rem 1.25rem;margin:0 0 0.75rem;font-family:Georgia,serif;font-size:14px;color:#5a3e20;line-height:1.7;">
          See something promising? Click <strong style="color:#2c1f0e;">Deep Analysis</strong> for a full professional appraisal — authenticity, condition, comparable sales and our valuation. Usually back to you within the hour.
          &nbsp;·&nbsp; 📸 <a href="${process.env.SITE_URL}/value" style="color:#c9922a;text-decoration:none;font-weight:bold;">Value any item you own →</a>
        </div>
        <div style="padding:1.25rem 1.25rem 0.5rem;">${listingBlocks}</div>
        <div style="padding:0.75rem 1.5rem 1rem;border-top:1px solid #e8d9b5;">
          <p style="font-size:13px;color:#8b6344;line-height:1.7;margin:0;">
            <a href="${process.env.SITE_URL}/install/${subscriber.access_token}" style="color:#c9922a;font-weight:bold;">My account &amp; submit item →</a>
            &nbsp;·&nbsp; <a href="${process.env.SITE_URL}/app?t=${subscriber.access_token}" style="color:#c9922a;font-weight:bold;">📱 Open in app →</a>
            &nbsp;·&nbsp; To update your brief, email <a href="mailto:alan@3scouts.com" style="color:#c9922a;">alan@3scouts.com</a>
            &nbsp;·&nbsp; <a href="https://billing.stripe.com/p/login/28E14g5sbcDi5nOc9b9Ve00" style="color:#8b6344;">Manage subscription</a>
            &nbsp;·&nbsp; Remember — Buy It Now prices are often negotiable.
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

Please be specific, expert and honest. Without physically seeing the item, caveat your assessment appropriately. Do not use markdown formatting — no #, ##, **, or --- symbols. Write in plain prose with numbered section headings. Today's date is June 2026. For comparable sales, use the most recent data available from your training and note that prices shown are approximate and from your knowledge base rather than live auction results.`;

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
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      messages,
    });

    const analysisText = claudeResponse.content[0].text;

    // Save to database
    const result = await client.query(
      `INSERT INTO deep_analyses (subscriber_id, ebay_item_id, listing_title, listing_url, listing_price, listing_image, analysis_text, report_token, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW()) RETURNING id, report_token`,
      [subscriberId, itemId, listing.title, listing.itemWebUrl, `${listing.price?.value} ${listing.price?.currency}`, imageUrl, analysisText, require('crypto').randomBytes(16).toString('hex')]
    );
    const reportId = result.rows[0].id;

    // Update usage count
    await client.query(
      'UPDATE subscribers SET deep_analyses_used = deep_analyses_used + 1 WHERE id = $1',
      [subscriberId]
    );

    // Send Deep Analysis email with report link
    await sendDeepAnalysisEmail(subscriber, listing, analysisText, imageUrl, reportId, reportToken);

    console.log(`Deep Analysis completed for ${subscriber.email} — ${listing.title}`);

  } finally {
    client.release();
  }
}


function parseAnalysisToHtml(analysisText) {
  const lines = analysisText
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && l !== '---' && l !== '***');

  let html = '';
  let sectionNum = 0;
  let inComparables = false;
  let comparableRows = [];

  const flushComparables = () => {
    if (comparableRows.length > 0) {
      html += buildComparableTable(comparableRows);
      comparableRows = [];
    }
    inComparables = false;
  };

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Strip markdown prefixes
    line = line.replace(/^#{1,3}\s+/, '');

    // Detect numbered section headers — ONLY lines starting with digit+dot
    const sectionMatch = line.match(/^(\d+)\.\s+(.+)/);
    if (sectionMatch) {
      flushComparables();
      sectionNum = parseInt(sectionMatch[1]);
      const title = sectionMatch[2].replace(/\*\*/g,'');

      // Section 4 = Comparable Sales — flag it
      if (sectionNum === 4) {
        inComparables = true;
        html += `<div style="background:#f5edd6;border-left:4px solid #c9922a;padding:8px 14px;margin:1.5rem 0 0.4rem;"><h4 style="font-family:Georgia,serif;font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#c9922a;margin:0;">${title}</h4></div>`;
      } else {
        html += `<div style="background:#f5edd6;border-left:4px solid #c9922a;padding:8px 14px;margin:1.5rem 0 0.4rem;"><h4 style="font-family:Georgia,serif;font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#c9922a;margin:0;">${title}</h4></div>`;
      }
      continue;
    }

    // If we're in comparables section, collect rows until next numbered section
    if (inComparables) {
      // Only flush if a new numbered section starts (handled above)
      // Skip lines that are section-like headers
      if (!line.match(/^[A-Z\s]{15,}$/) || line.match(/[a-z£€$\d]/)) {
        const clean = line.replace(/^[-•*\d]+\.?\s*/, '').replace(/\*\*/g,'');
        if (clean.length > 10) comparableRows.push(clean);
      }
      continue;
    }

    // Valuation range — highlight panel
    if (sectionNum === 5 && line.match(/[£€$]/) && line.match(/\d/)) {
      const clean = line.replace(/\*\*/g,'');
      html += `<div style="background:#2c1f0e;border-radius:3px;padding:1rem 1.25rem;margin:0.5rem 0 0.75rem;"><p style="font-family:Georgia,serif;font-size:16px;font-weight:700;color:#e8b84b;margin:0;line-height:1.6;">${clean}</p></div>`;
      continue;
    }

    // Authenticity confidence % — green panel
    if (line.match(/\d+%/) && line.match(/confidence|authentic|genuine/i)) {
      const pct = parseInt((line.match(/(\d+)%/) || [])[1] || 0);
      const barColor = pct >= 75 ? '#1a6b2e' : pct >= 50 ? '#c9922a' : '#8b2020';
      const clean = line.replace(/\*\*/g,'');
      html += `<div style="background:#f0f7ee;border-left:4px solid #1a4a2e;padding:10px 14px;margin:0.5rem 0 0.75rem;">
        <p style="font-size:14px;color:#1a4a2e;font-weight:700;margin:0 0 8px;">${clean}</p>
        ${pct ? `<div style="background:#d0e8d0;border-radius:3px;height:6px;overflow:hidden;"><div style="background:${barColor};height:100%;width:${pct}%;border-radius:3px;"></div></div>` : ''}
      </div>`;
      continue;
    }

    // Condition grade — extract grade letter and build bar
    if (line.match(/overall.*grade|grade.*overall/i) || (sectionNum === 3 && line.match(/grade\s*[A-D][+-]?/i))) {
      const gradeMatch = line.match(/grade\s*([A-D][+-]?)/i);
      const grade = gradeMatch ? gradeMatch[1].toUpperCase() : null;
      const gradeWidths = {'A+':100,'A':92,'A-':85,'B+':78,'B':70,'B-':62,'C+':54,'C':46,'C-':38,'D':25};
      const gradeColors = {'A+':'#1a6b2e','A':'#1a6b2e','A-':'#2d8a3e','B+':'#c9922a','B':'#c9922a','B-':'#d4882a','C+':'#8b4a1e','C':'#8b2020','C-':'#8b2020','D':'#6b1010'};
      const clean = line.replace(/\*\*/g,'');
      html += `<div style="background:#f5edd6;border:1px solid #c9922a;border-radius:3px;padding:10px 14px;margin:0.5rem 0 0.75rem;">
        <p style="font-size:14px;color:#2c1f0e;font-weight:700;margin:0 0 ${grade ? '8px' : '0'};">${clean}</p>
        ${grade ? `<div style="background:#e8d9b5;border-radius:3px;height:6px;overflow:hidden;"><div style="background:${gradeColors[grade]||'#c9922a'};height:100%;width:${gradeWidths[grade]||50}%;border-radius:3px;"></div></div>` : ''}
      </div>`;
      continue;
    }

    // Sub-headings ending with colon (short lines only)
    if (line.match(/^[A-Z][^.!?]{3,50}:\s*$/) && !line.match(/^\d/)) {
      const clean = line.replace(/\*\*/g,'').replace(/:$/, '');
      html += `<p style="font-family:Georgia,serif;font-size:15px;font-weight:700;color:#2c1f0e;margin:1rem 0 0.3rem;">${clean}</p>`;
      continue;
    }

    // Bullet points
    if (line.match(/^[-•*]\s/)) {
      const clean = line.replace(/^[-•*]\s/, '').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
      html += `<p style="font-size:14.5px;color:#5a3e20;line-height:1.8;margin:0 0 0.35rem;padding-left:1.25rem;border-left:2px solid #e8d9b5;">${clean}</p>`;
      continue;
    }

    // Convert inline **bold**
    line = line.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');

    html += `<p style="font-size:15px;color:#2c1f0e;line-height:1.85;margin:0 0 0.6rem;">${line}</p>`;
  }

  // Flush any remaining comparables
  flushComparables();

  return html;
}

function buildComparableTable(rows) {
  if (!rows.length) return '';
  const tableRows = rows.map((row, idx) => {
    row = row.replace(/\*\*/g, '');
    const bg = idx % 2 === 0 ? '#ffffff' : '#faf7f2';
    return `<tr style="background:${bg};">
      <td style="padding:9px 12px;border-bottom:1px solid #e8d9b5;font-size:13.5px;color:#2c1f0e;line-height:1.65;">${row}</td>
    </tr>`;
  }).join('');

  return `<table style="width:100%;border-collapse:collapse;margin:0.5rem 0 1.25rem;background:#fff;border:1px solid #e8d9b5;border-radius:3px;overflow:hidden;">
    <thead><tr>
      <th style="background:#c9922a;padding:8px 12px;text-align:left;font-family:Georgia,serif;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;">Comparable sale</th>
    </tr></thead>
    <tbody>${tableRows}</tbody>
  </table>`;
}


async function sendDeepAnalysisEmail(subscriber, listing, analysisText, imageUrl, reportId, reportToken) {
  const price = `${listing.price?.value} ${listing.price?.currency}`;
  const reportUrl = `${process.env.SITE_URL}/report/${reportToken || reportId}`;
  const dateStr = new Date().toLocaleDateString('en-IE', { day: 'numeric', month: 'long', year: 'numeric' });

  await resend.emails.send({
    from: '3scouts <scout@3scouts.com>',
    reply_to: 'alan@3scouts.com',
    to: subscriber.email,
    bcc: ['alan@aka.ie', 'akeane60@gmail.com'],
    subject: `3scouts Deep Analysis ready — ${listing.title?.substring(0, 50)}`,
    html: `
      <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;background:#f5edd6;padding:0;border-top:4px solid #c9922a;">

        <div style="background:#2c1f0e;padding:1rem 1.5rem;border-bottom:2px solid #c9922a;">
          <p style="font-size:11px;letter-spacing:2px;color:#c9922a;margin:0 0 4px;text-transform:uppercase;">3scouts · Deep Analysis Report</p>
          <h2 style="font-size:1.1rem;font-weight:500;color:#fffdf7;margin:0 0 5px;line-height:1.4;">${listing.title}</h2>
          <p style="font-size:13px;color:rgba(255,255,255,0.45);margin:0;">Listed at <strong style="color:#e8b84b;">${price}</strong> &nbsp;·&nbsp; ${dateStr}</p>
        </div>

        ${imageUrl ? `<div style="background:#1a0e05;text-align:center;padding:1rem 1.5rem;border-bottom:1px solid #3a2a15;">
          <img src="${imageUrl}" alt="${listing.title}" style="max-width:100%;max-height:260px;object-fit:contain;border-radius:3px;">
        </div>` : ''}

        <div style="padding:1.75rem 1.5rem;background:#ffffff;border-bottom:1px solid #e8d9b5;text-align:center;">
          <p style="font-size:15px;color:#2c1f0e;line-height:1.85;margin:0 0 1.25rem;">Your full Deep Analysis report is ready — authenticity assessment, condition grading, comparable sales and our valuation.</p>
          <a href="${reportUrl}" style="display:inline-block;background:#c9922a;color:#2c1f0e;font-family:Georgia,serif;font-size:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:14px 32px;border-radius:3px;text-decoration:none;">View Full Report →</a>
          <p style="font-size:12px;color:#8b6344;margin:1rem 0 0;">Or copy this link: <a href="${reportUrl}" style="color:#c9922a;">${reportUrl}</a></p>
        </div>

        <div style="background:#f5edd6;padding:0.75rem 1.5rem;border-bottom:1px solid #e8d9b5;">
          <p style="font-size:12.5px;color:#5a3e20;margin:0;line-height:1.6;">
            <strong>Your brief:</strong> ${subscriber.description || subscriber.category}
            &nbsp;·&nbsp; <a href="${listing.itemWebUrl}" style="color:#c9922a;">View on eBay →</a>
          </p>
        </div>

        <div style="background:#e8d9b5;padding:0.75rem 1.5rem;">
          <p style="font-size:12px;color:#8b6344;margin:0;line-height:1.7;">
            <a href="https://www.3scouts.com" style="color:#c9922a;">3scouts.com</a>
            &nbsp;·&nbsp; <a href="https://billing.stripe.com/p/login/28E14g5sbcDi5nOc9b9Ve00" style="color:#8b6344;">Manage subscription</a>
          </p>
        </div>
      </div>
    `,
  });
}


async function sendValuationEmail(subscriber, description, analysisText, imageDataUrls, reportId, reportToken) {
  const reportUrl = `${process.env.SITE_URL}/report/${reportToken || reportId}`;
  const dateStr = new Date().toLocaleDateString('en-IE', { day: 'numeric', month: 'long', year: 'numeric' });
  const firstImage = imageDataUrls && imageDataUrls[0] ? imageDataUrls[0] : null;

  await resend.emails.send({
    from: '3scouts <scout@3scouts.com>',
    reply_to: 'alan@3scouts.com',
    to: subscriber.email,
    bcc: ['alan@aka.ie', 'akeane60@gmail.com'],
    subject: `3scouts Valuation Report ready — ${description.substring(0, 50)}`,
    html: `
      <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;background:#f5edd6;padding:0;border-top:4px solid #c9922a;">

        <div style="background:#2c1f0e;padding:1rem 1.5rem;border-bottom:2px solid #c9922a;">
          <p style="font-size:11px;letter-spacing:2px;color:#c9922a;margin:0 0 4px;text-transform:uppercase;">3scouts · Valuation Report</p>
          <h2 style="font-size:1.1rem;font-weight:500;color:#fffdf7;margin:0 0 5px;line-height:1.4;">${description.substring(0, 100)}</h2>
          <p style="font-size:13px;color:rgba(255,255,255,0.45);margin:0;">${dateStr}</p>
        </div>

        ${firstImage ? `<div style="background:#1a0e05;text-align:center;padding:1rem 1.5rem;border-bottom:1px solid #3a2a15;">
          <img src="${firstImage}" alt="Submitted item" style="max-width:100%;max-height:260px;object-fit:contain;border-radius:3px;">
        </div>` : ''}

        <div style="padding:1.75rem 1.5rem;background:#ffffff;border-bottom:1px solid #e8d9b5;text-align:center;">
          <p style="font-size:15px;color:#2c1f0e;line-height:1.85;margin:0 0 1.25rem;">Your full valuation report is ready — item identification, authenticity assessment, condition grading, comparable sales and our valuation.</p>
          <a href="${reportUrl}" style="display:inline-block;background:#c9922a;color:#2c1f0e;font-family:Georgia,serif;font-size:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:14px 32px;border-radius:3px;text-decoration:none;">View Full Report →</a>
          <p style="font-size:12px;color:#8b6344;margin:1rem 0 0;">Or copy this link: <a href="${reportUrl}" style="color:#c9922a;">${reportUrl}</a></p>
        </div>

        ${!subscriber.active ? `
        <div style="background:#2c1f0e;padding:1.25rem 1.5rem;border-bottom:1px solid #c9922a;">
          <p style="font-family:Georgia,serif;font-size:12px;font-weight:700;color:#c9922a;letter-spacing:1px;text-transform:uppercase;margin:0 0 0.5rem;">Enjoyed your appraisal?</p>
          <p style="font-size:14px;color:rgba(255,255,255,0.8);line-height:1.7;margin:0 0 1rem;">Subscribe to get 20 Deep Analyses per month — plus continuous eBay monitoring for whatever you collect. First 30 days free.</p>
          <a href="https://www.3scouts.com/#brief" style="display:inline-block;background:#c9922a;color:#2c1f0e;font-family:Georgia,serif;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:10px 20px;border-radius:3px;text-decoration:none;">Start my free trial →</a>
        </div>` : ''}

        <div style="background:#e8d9b5;padding:0.75rem 1.5rem;">
          <p style="font-size:12px;color:#8b6344;margin:0;line-height:1.7;">
            <a href="https://www.3scouts.com" style="color:#c9922a;">3scouts.com</a>
            &nbsp;·&nbsp; alan@3scouts.com
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
          <p style="font-size:15px;color:#2c1f0e;line-height:1.85;margin:0 0 0.5rem;">Your first <strong>30 days are completely free</strong>. Then just €20 a month. No contracts, no commitments — cancel anytime in one click before your trial ends and you won't be charged a penny.</p>
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

// ── SUBSCRIBER MANAGEMENT ─────────────────────────────────────────

async function runDeepAnalysisFromDescription(subscriberId, description, imageDataUrls) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();

  try {
    const { rows } = await client.query('SELECT * FROM subscribers WHERE id = $1', [subscriberId]);
    if (!rows.length) throw new Error('Subscriber not found');
    const subscriber = rows[0];

    // Check allowance
    if (subscriber.deep_analyses_used >= subscriber.deep_analyses_limit) {
      await sendDeepAnalysisLimitEmail(subscriber);
      return;
    }

    // Build image content
    console.log(`runDeepAnalysis: received ${imageDataUrls.length} image(s) for ${subscriber.email}`);
    const imageContents = [];
    for (const dataUrl of (imageDataUrls || []).slice(0, 5)) {
      const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (matches) {
        console.log(`  Image: mime=${matches[1]} size=${matches[2].length} chars`);
        imageContents.push({ type: 'image', source: { type: 'base64', media_type: matches[1], data: matches[2] } });
      }
    }
    console.log(`runDeepAnalysis: sending ${imageContents.length} image(s) to Claude`);

    const prompt = `You are an expert antiques and collectables appraiser for 3scouts.com. The service is based in Ireland and primarily serves European and UK collectors.

A subscriber has submitted ${imageContents.length} photo${imageContents.length > 1 ? 's' : ''} of a SINGLE item they want appraised and valued. All photos are of the same item — some may show the front, back, details or markings of the same piece. Do not treat them as separate items.

Their description: ${description}

Please provide a full Deep Analysis covering:
1. ITEM IDENTIFICATION — What is this item? Who made it? When was it made?
2. AUTHENTICITY ASSESSMENT — Is this genuine? What evidence supports or challenges authenticity? Give a confidence percentage.
3. CONDITION ASSESSMENT — Grade each visible aspect. Give an overall grade (A/B/C/D) with explanation.
4. COMPARABLE SALES — What have similar items sold for recently? Give 3-5 comparable examples with prices and dates if possible. Use EUR (€) or GBP (£) for valuations.
5. VALUATION — What is your fair value estimate range? Express in EUR (€) or GBP (£).
6. RECOMMENDATION — Is this worth pursuing or keeping at the implied value? Plain English, no jargon.
7. ANY RED FLAGS — What should the owner verify or be cautious about?

Be specific, expert and honest. Note that without physically examining the item, your assessment is based on the photographs provided. Do not use markdown formatting — no #, ##, **, or --- symbols. Write in plain prose with numbered section headings. Today's date is June 2026. For comparable sales, use the most recent data available and note that prices shown are from your knowledge base.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      messages: [{
        role: 'user',
        content: [
          ...imageContents,
          { type: 'text', text: prompt }
        ]
      }]
    });

    const analysisText = response.content[0].text;

    // Save to database
    const firstImage = imageDataUrls && imageDataUrls[0] ? imageDataUrls[0] : null;
    const allImages = imageDataUrls && imageDataUrls.length > 0 ? JSON.stringify(imageDataUrls) : null;
    const result = await client.query(
      `INSERT INTO deep_analyses (subscriber_id, ebay_item_id, listing_title, listing_image, analysis_text, report_token, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING id, report_token`,
      [subscriberId, 'valuation-' + Date.now(), description.substring(0, 200), allImages || firstImage, analysisText, require('crypto').randomBytes(16).toString('hex')]
    );
    const reportId = result.rows[0].id;
    const reportToken = result.rows[0].report_token;

    // Update usage count
    await client.query(
      'UPDATE subscribers SET deep_analyses_used = deep_analyses_used + 1 WHERE id = $1',
      [subscriberId]
    );

    // Send notification email with report link
    await sendValuationEmail(subscriber, description, analysisText, imageDataUrls, reportId, reportToken);

    // Queue follow-up email in database — survives server restarts
    if (!subscriber.active || subscriber.plan === 'Free Valuation') {
      try {
        await client.query(
          `INSERT INTO follow_up_queue (email, name, send_after)
           VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
          [subscriber.email, subscriber.name]
        );
        console.log(`Follow-up queued for ${subscriber.email} in 1 hour`);
      } catch(e) {
        console.error('Follow-up queue error:', e.message);
      }
    }

    console.log(`Valuation completed for ${subscriber.email}`);

  } finally {
    client.release();
    await pool.end();
  }
}

async function sendDeepAnalysisLimitEmail(subscriber) {
  const topupUrl = `${process.env.SITE_URL}/topup?email=${encodeURIComponent(subscriber.email)}`;
  await resend.emails.send({
    from: '3scouts <scout@3scouts.com>',
    reply_to: 'alan@3scouts.com',
    to: subscriber.email,
    bcc: ['alan@aka.ie', 'akeane60@gmail.com'],
    subject: '3scouts — Deep Analysis allowance reached',
    html: `
      <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;background:#f5edd6;padding:0;border-top:4px solid #c9922a;">
        <div style="background:#2c1f0e;padding:1rem 1.5rem;border-bottom:2px solid #c9922a;">
          <p style="font-size:11px;letter-spacing:2px;color:#c9922a;margin:0 0 4px;text-transform:uppercase;">3scouts · Allowance reached</p>
          <h2 style="font-size:1.1rem;font-weight:500;color:#fffdf7;margin:0;">Your Deep Analysis allowance is used up</h2>
        </div>
        <div style="padding:1.5rem;background:#ffffff;border-bottom:1px solid #e8d9b5;">
          <p style="font-size:15px;color:#2c1f0e;line-height:1.85;margin:0 0 1rem;">Dear ${subscriber.name}, you've used all ${subscriber.deep_analyses_limit} Deep Analyses included in your current plan.</p>
          <p style="font-size:15px;color:#5a3e20;line-height:1.85;margin:0 0 1.5rem;">Top up for just <strong style="color:#2c1f0e;">€2 per 10 analyses</strong> — or upgrade your plan.</p>
          <a href="${topupUrl}" style="display:inline-block;background:#c9922a;color:#2c1f0e;font-family:Georgia,serif;font-size:13px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;padding:12px 24px;border-radius:3px;text-decoration:none;">Top up — €2 for 10 analyses →</a>
        </div>
        <div style="background:#e8d9b5;padding:0.75rem 1.5rem;">
          <p style="font-size:12px;color:#8b6344;margin:0;">3scouts.com · <a href="mailto:alan@3scouts.com" style="color:#c9922a;">alan@3scouts.com</a></p>
        </div>
      </div>
    `,
  });
}

async function upsertSubscriber(data) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    const deepLimit = data.plan?.includes('Dealer') ? 150 : data.plan?.includes('Collector') ? 60 : 20;
    await client.query(
      `INSERT INTO subscribers (name, email, plan, category, description, budget, negative_keywords, territories, frequency, active, deep_analyses_limit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10)
       ON CONFLICT (email) DO UPDATE SET
         name = EXCLUDED.name,
         plan = EXCLUDED.plan,
         category = EXCLUDED.category,
         description = EXCLUDED.description,
         budget = EXCLUDED.budget,
         negative_keywords = EXCLUDED.negative_keywords,
         territories = EXCLUDED.territories,
         frequency = EXCLUDED.frequency,
         active = true,
         deep_analyses_limit = EXCLUDED.deep_analyses_limit`,
      [data.name, data.email, data.plan, data.category, data.description,
       data.budget, data.negative, data.territories, data.frequency, deepLimit]
    );
  } finally {
    client.release();
    await pool.end();
  }
}

async function deactivateSubscriber(email) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    await client.query('UPDATE subscribers SET active = false WHERE email = $1', [email]);
  } finally {
    client.release();
    await pool.end();
  }
}

// ── SCOUT RUN ─────────────────────────────────────────────────────

async function runScouts() {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();

  try {
    const now = new Date();
    const irishTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Dublin' }));
    const hour = irishTime.getHours();
    const dayOfWeek = irishTime.getDay(); // 0=Sun, 1=Mon

    const { rows: subscribers } = await client.query(
      'SELECT * FROM subscribers WHERE active = true'
    );

    console.log(`Scout run started — ${subscribers.length} active subscriber(s) — ${irishTime.toLocaleString('en-IE')}`);

    const token = await getEbayToken();

    for (const subscriber of subscribers) {
      try {
        // Check alert frequency
        const freq = subscriber.frequency || 'twice';
        let shouldAlert = false;

        if (freq === 'immediate') {
          shouldAlert = true;
        } else if (freq === 'morning' && hour === 8) {
          shouldAlert = true;
        } else if (freq === 'evening' && hour === 18) {
          shouldAlert = true;
        } else if (freq === 'twice' && (hour === 8 || hour === 18)) {
          shouldAlert = true;
        } else if (freq === 'weekly' && dayOfWeek === 1 && hour === 8) {
          shouldAlert = true;
        }

        if (!shouldAlert) {
          console.log(`Skipping ${subscriber.email} — not alert time yet (freq: ${freq}, hour: ${hour})`);
          continue;
        }

        console.log(`Searching eBay for: ${subscriber.email} — ${subscriber.description || subscriber.category}`);

        const listings = await searchEbay(subscriber, token);
        console.log(`Total listings found for ${subscriber.email}: ${listings.length}`);

        if (!listings.length) {
          console.log(`Found 0 listings for ${subscriber.email}`);
          continue;
        }

        // Check seen listings
        const { rows: seenRows } = await client.query(
          'SELECT ebay_item_id FROM seen_listings WHERE subscriber_id = $1',
          [subscriber.id]
        );
        const seenIds = new Set(seenRows.map(r => r.ebay_item_id));

        // Filter to new, relevant listings
        const newMatches = [];
        for (const listing of listings) {
          if (seenIds.has(listing.itemId)) continue;
          if (!isRelevantListing(listing, subscriber)) {
            console.log(`Filtered out: ${listing.title}`);
            continue;
          }

          // Mark as seen
          await client.query(
            'INSERT INTO seen_listings (subscriber_id, ebay_item_id, seen_at) VALUES ($1, $2, NOW()) ON CONFLICT DO NOTHING',
            [subscriber.id, listing.itemId]
          );

          newMatches.push(listing);
        }

        console.log(`Found ${newMatches.length} new matches for ${subscriber.email}`);

        if (!newMatches.length) {
          console.log(`0 new matches for ${subscriber.email}`);
          continue;
        }

        // Get quick estimates in parallel
        const withEstimates = await Promise.all(
          newMatches.map(async listing => {
            const est = await getQuickEstimate(listing, subscriber);
            return { ...listing, ...est };
          })
        );

        // Rank and cap
        let digestMatches = withEstimates;
        if (withEstimates.length > 10) {
          console.log(`Ranking ${withEstimates.length} matches for ${subscriber.email} — selecting top 10`);
          digestMatches = await rankListings(withEstimates, subscriber);
        }

        // Send digest
        if (digestMatches.length > 0) {
          await sendDigestEmail(subscriber, digestMatches);
          await client.query(
            'UPDATE subscribers SET last_alerted_at = NOW() WHERE id = $1',
            [subscriber.id]
          );
          console.log(`Digest sent to ${subscriber.email}: ${digestMatches.length} match(es) (from ${newMatches.length} found)`);
        }

        // Clean old seen listings (> 30 days)
        await client.query(
          'DELETE FROM seen_listings WHERE subscriber_id = $1 AND seen_at < NOW() - INTERVAL \'30 days\'',
          [subscriber.id]
        );

      } catch(err) {
        console.error(`Scout error for ${subscriber.email}:`, err.message);
      }
    }

    console.log(`Scout run completed: ${new Date().toISOString()}`);

  } finally {
    client.release();
    await pool.end();
  }
}

// ── SCHEDULER ─────────────────────────────────────────────────────

function scheduleTopOfHour() {
  const now = new Date();
  const msUntilNextHour = (60 - now.getMinutes()) * 60 * 1000 - now.getSeconds() * 1000 - now.getMilliseconds();
  console.log(`Next Scout run in ${Math.round(msUntilNextHour / 60000)} minutes`);
  setTimeout(() => {
    runScouts().catch(err => console.error('Scout run error:', err.message));
    setInterval(() => {
      runScouts().catch(err => console.error('Scout run error:', err.message));
    }, 60 * 60 * 1000);
  }, msUntilNextHour);
}

scheduleTopOfHour();

async function processFollowUpQueue() {
  const pool2 = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client2 = await pool2.connect();
  try {
    const result = await client2.query(
      `SELECT id, email, name FROM follow_up_queue
       WHERE sent = FALSE AND send_after <= NOW()
       LIMIT 10`
    );
    for (const row of result.rows) {
      try {
        await sendValuationFollowUp(row.email, row.name);
        await client2.query('UPDATE follow_up_queue SET sent = TRUE WHERE id = $1', [row.id]);
        console.log(`Follow-up sent to ${row.email}`);
      } catch(e) {
        console.error(`Follow-up failed for ${row.email}:`, e.message);
      }
    }
  } finally {
    client2.release();
    await pool2.end();
  }
}

module.exports = {
  initDatabase,
  runScouts,
  upsertSubscriber,
  deactivateSubscriber,
  runDeepAnalysis,
  runDeepAnalysisFromDescription,
  processFollowUpQueue,
};
