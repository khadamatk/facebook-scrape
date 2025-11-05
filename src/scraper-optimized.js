// src/scraper-optimized.js
import 'dotenv/config';
import { login } from './login.js';
import { sleep, parseCount, sanitizeText } from './utils.js';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';

/**
 * Optimized Facebook Scraper - Extract posts with engagement metrics
 */
export async function scrapeFacebookPageOptimized(options = {}) {
  const {
    FB_PAGE_URL,
    POSTS_TARGET = 10,
    SCROLL_DELAY_MS = 3000,
    SAVE_TO_FILE = false,
  } = options;

  if (!FB_PAGE_URL) {
    throw new Error('FB_PAGE_URL is required');
  }

  let browser = null;
  let page = null;

  try {
    const loginResult = await login();
    browser = loginResult.browser;
    page = loginResult.page;

    console.log(`[Scraper] Starting scrape for: ${FB_PAGE_URL}`);
    await sleep(2000);

    // Navigate to page
    await page.goto(FB_PAGE_URL, { waitUntil: 'networkidle2' });
    await sleep(1500);

    // Close cookie dialog
    try {
      await page.click('button[title="Only allow essential cookies"]');
    } catch (_) {}

    await sleep(1000);

    // Get page name
    let pageName = await page.$eval('h1', (el) => el.innerText.trim()).catch(() => null);
    if (!pageName) {
      pageName = await page.evaluate(() => {
        const el = document.querySelector('[role="heading"][aria-level="1"], h1');
        return el ? el.innerText.trim() : null;
      });
    }

    console.log(`[Scraper] Page: ${pageName}`);

    // Scroll to load posts
    console.log(`[Scraper] Loading ${POSTS_TARGET} posts...`);
    let lastCount = 0;
    let stalls = 0;

    for (let i = 0; i < 100; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await sleep(SCROLL_DELAY_MS);

      const count = await page.$$eval('div[role="article"]', (nodes) => nodes.length);
      console.log(`[Scraper] Loaded ${count} posts...`);

      if (count >= POSTS_TARGET) break;
      if (count <= lastCount) stalls++;
      else stalls = 0;

      lastCount = count;
      if (stalls >= 5) break;
    }

    // Extract posts with engagement metrics
    const posts = await page.$$eval('div[role="article"]', (nodes) => {
      // Helper: Convert Arabic numerals to Latin
      const arabicToLatin = (str) => {
        if (!str) return '';
        return String(str)
          .replace(/٠/g, '0').replace(/١/g, '1').replace(/٢/g, '2')
          .replace(/٣/g, '3').replace(/٤/g, '4').replace(/٥/g, '5')
          .replace(/٦/g, '6').replace(/٧/g, '7').replace(/٨/g, '8')
          .replace(/٩/g, '9');
      };

      // Extract post text
      const extractPostText = (article) => {
        let text = article.innerText || '';
        text = text.replace(/عرض المزيد|See more/gi, '');
        const splitOn = /(أعجبني|تعليق|مشاركة|Like|Comment|Share)/i;
        const parts = text.split(splitOn);
        return (parts[0] || text).replace(/\s+/g, ' ').trim();
      };

      // Extract engagement metrics
      const extractEngagement = (article, metric) => {
        const allText = article.innerText || '';
        const normalizedText = arabicToLatin(allText);

        // Strategy 1: Parse "كل التفاعلات: 571 571 2 8"
        if (/كل التفاعلات:/i.test(allText)) {
          const afterLabel = normalizedText.split(/كل\s*التفاعلات:\s*/i)[1];
          
          if (afterLabel) {
            const numbers = afterLabel.match(/\b(\d+)\b/g);
            
            if (numbers && numbers.length >= 4) {
              // Format: reactions emoji_count comments shares
              const reactions = parseInt(numbers[0], 10);
              const comments = parseInt(numbers[2], 10);
              const shares = parseInt(numbers[3], 10);

              if (metric === 'reactions') return reactions;
              if (metric === 'comments') return comments;
              if (metric === 'shares') return shares;
            } else if (numbers && numbers.length >= 2) {
              // Format: reactions comments (no shares)
              const reactions = parseInt(numbers[0], 10);
              const comments = parseInt(numbers[1], 10);

              if (metric === 'reactions') return reactions;
              if (metric === 'comments') return comments;
              if (metric === 'shares') return 0;
            } else if (numbers && numbers.length === 1) {
              if (metric === 'reactions') return parseInt(numbers[0], 10);
            }
          }
        }

        // Strategy 2: aria-label buttons
        try {
          const buttons = Array.from(article.querySelectorAll('[aria-label]'));
          for (const btn of buttons) {
            const label = arabicToLatin((btn.getAttribute('aria-label') || '').toLowerCase());

            if (metric === 'reactions' && /اعجاب|like|تفاعل|react/i.test(label)) {
              const match = label.match(/(\d+)/);
              if (match) return parseInt(match[1], 10);
            }

            if (metric === 'comments' && /تعليق|comment|رد/i.test(label)) {
              const match = label.match(/(\d+)/);
              if (match) return parseInt(match[1], 10);
            }

            if (metric === 'shares' && /مشاركة|share/i.test(label)) {
              const match = label.match(/(\d+)/);
              if (match) return parseInt(match[1], 10);
            }
          }
        } catch (e) {}

        return 0;
      };

      // Extract post date
      const extractDate = (article) => {
        const timeEl = article.querySelector('time[datetime]');
        if (timeEl) return timeEl.getAttribute('datetime');

        const text = article.innerText || '';
        const match = text.match(/(\d{1,2}\s+[A-Za-z\u0600-\u06FF]+\s+الساعة\s+\d{1,2}:\d{2}|[0-9\u0660-\u0669]+\s*[سدي]|[0-9\u0660-\u0669]+\s*[hd])/u);
        return match ? match[1] : null;
      };

      // Map and filter posts
      return nodes.map((article, idx) => {
        const text = extractPostText(article);
        const reactions = extractEngagement(article, 'reactions');
        const comments = extractEngagement(article, 'comments');
        const shares = extractEngagement(article, 'shares');
        const date = extractDate(article);
        const totalEngagement = reactions + comments + shares;

        return {
          id: idx + 1,
          text: text || 'N/A',
          reactions,
          comments,
          shares,
          total_engagement: totalEngagement,
          date: date || null
        };
      }).filter(p => p.text && p.text !== 'N/A' && p.text.length > 5);
    });

    // Calculate statistics
    const summary = {
      total_posts: posts.length,
      total_reactions: posts.reduce((sum, p) => sum + p.reactions, 0),
      total_comments: posts.reduce((sum, p) => sum + p.comments, 0),
      total_shares: posts.reduce((sum, p) => sum + p.shares, 0),
      avg_reactions: posts.length > 0 ? Math.round(posts.reduce((sum, p) => sum + p.reactions, 0) / posts.length) : 0,
      avg_comments: posts.length > 0 ? Math.round(posts.reduce((sum, p) => sum + p.comments, 0) / posts.length) : 0,
      avg_shares: posts.length > 0 ? Math.round(posts.reduce((sum, p) => sum + p.shares, 0) / posts.length) : 0,
      best_post: posts.length > 0 ? posts.reduce((best, p) => p.total_engagement > best.total_engagement ? p : best) : null
    };

    const result = {
      page: {
        name: pageName,
        url: FB_PAGE_URL
      },
      posts: posts.slice(0, POSTS_TARGET),
      summary,
      scraped_at: new Date().toISOString()
    };

    // Save to file if needed
    if (SAVE_TO_FILE) {
      try {
        const outputsDirUrl = new URL('../outputs/', import.meta.url);
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const outFileUrl = new URL(`facebook-scrape-${ts}.json`, outputsDirUrl);
        await fs.mkdir(fileURLToPath(outputsDirUrl), { recursive: true });
        await fs.writeFile(fileURLToPath(outFileUrl), JSON.stringify(result, null, 2), 'utf-8');
        console.log(`[Scraper] ✅ Saved to: ${fileURLToPath(outFileUrl)}`);
      } catch (err) {
        console.warn('[Scraper] ⚠️ Warning: Could not save file:', err.message);
      }
    }

    console.log('[Scraper] ✅ Done!');
    return result;

  } catch (err) {
    console.error('[Scraper] ❌ Error:', err.message);
    throw err;
  } finally {
    if (page) await page.close().catch(e => console.warn('⚠️ Could not close page:', e.message));
    if (browser) await browser.close().catch(e => console.warn('⚠️ Could not close browser:', e.message));
  }
}

// Standalone execution
if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeFacebookPageOptimized({
    FB_PAGE_URL: process.env.FB_PAGE_URL,
    POSTS_TARGET: parseInt(process.env.POSTS_TARGET || '10', 10),
    SCROLL_DELAY_MS: parseInt(process.env.SCROLL_DELAY_MS || '3000', 10),
    SAVE_TO_FILE: true
  })
    .then(result => {
      console.log('\n📊 Final Result:');
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch(err => {
      console.error('❌ Fatal Error:', err);
      process.exit(1);
    });
}
