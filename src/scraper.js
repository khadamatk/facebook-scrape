// src/scraper.js
import 'dotenv/config';
import { login } from './login.js';
import { getText, findTextByRegex, scrollPageToBottom, sanitizeText, sleep, parseCount, clickSeeMoreInArticles, parseDateToISO, closePostOverlay } from './utils.js';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';

/**
 * Main scraper function - exports for use in API or standalone
 * @param {Object} options - Configuration options
 * @returns {Promise<Object>} Scrape result with posts, followers, likes, etc.
 */
export async function scrapeFacebookPage(options = {}) {
  const {
    FB_PAGE_URL,
    FOLLOWERS_XPATH,
    LIKES_XPATH,
    POSTS_TARGET = 100,
    SCROLL_DELAY_MS = 2000,
    SCROLL_STALL_LIMIT = 10,
    SCROLL_MAX_LOOPS = 300,
    SAVE_TO_FILE = true,
    saveDir = null,
  } = options;

  if (!FB_PAGE_URL) {
    throw new Error('FB_PAGE_URL is required');
  }

  let browser = null;
  let page = null;
  let aboutPage = null;

  try {
    // Login and get browser/page
    const loginResult = await login();
    browser = loginResult.browser;
    page = loginResult.page;

    // Short wait after login
    await sleep(3000);

    // Navigate to page with retry logic
    await gotoWithRetry(page, FB_PAGE_URL, { waitUntil: 'networkidle2' });
    await sleep(1500);

    // Try to close cookie dialogs
    try {
      await page.click('button[title="Only allow essential cookies"]');
    } catch (_) {}

    // Navigate to Posts tab
    const base = FB_PAGE_URL.endsWith('/') ? FB_PAGE_URL.slice(0, -1) : FB_PAGE_URL;
    const postTabCandidates = [`${base}?sk=posts`, `${base}/posts`];
    let navigatedToPosts = false;

    for (const u of postTabCandidates) {
      try {
        await gotoWithRetry(page, u, { waitUntil: 'domcontentloaded' });
        const hasArticles = await page.$$eval('div[role="article"]', (n) => n.length);
        if (hasArticles > 0) {
          navigatedToPosts = true;
          break;
        }
      } catch (err) {
        console.warn(`Failed to navigate to ${u}:`, err.message);
      }
    }

    // If URL approach didn't work, try DOM click
    if (!navigatedToPosts) {
      try {
        const clicked = await page.evaluate(() => {
          const candidates = Array.from(document.querySelectorAll('a[role="tab"], a[role="link"], div[role="tab"], span, a'));
          const match = (t) => {
            const s = (t || '').toLowerCase();
            return s.includes('المنشورات') || s.includes('posts');
          };
          for (const el of candidates) {
            const txt = (el.innerText || el.textContent || '').trim();
            if (match(txt)) {
              try {
                if (typeof el.click === 'function') {
                  el.click();
                  return true;
                }
              } catch {}
            }
          }
          return false;
        });

        if (clicked) {
          await page.waitForSelector('div[role="article"]', { timeout: 8000 });
          navigatedToPosts = true;
        }
      } catch (err) {
        console.warn('DOM click failed:', err.message);
      }
    }

    // Extract page title
    let pageTitle = await getText(page, 'h1');
    if (!pageTitle) pageTitle = await getText(page, 'h1 span');
    if (!pageTitle) {
      pageTitle = await page.evaluate(() => {
        const el = document.querySelector('[role="heading"][aria-level="1"], h1');
        return el ? el.innerText.trim() : null;
      });
    }

    // Helper to extract by XPath
    async function extractByXPath(pg, xpathExpr) {
      if (!xpathExpr) return null;
      try {
        return await pg.evaluate((xp) => {
          try {
            const res = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            const node = res.singleNodeValue;
            if (!node) return null;
            return (node.textContent || '').trim();
          } catch (e) {
            return null;
          }
        }, xpathExpr);
      } catch (err) {
        console.warn('XPath extraction failed:', err.message);
        return null;
      }
    }

    // Extract followers and likes
    let followers = null;
    let likes = null;

    // Custom XPath layer
    if (FOLLOWERS_XPATH) {
      const txt = await extractByXPath(page, FOLLOWERS_XPATH);
      const n = parseCount(txt);
      if (n != null) followers = n;
    }
    if (LIKES_XPATH) {
      const txt = await extractByXPath(page, LIKES_XPATH);
      const n = parseCount(txt);
      if (n != null) likes = n;
    }

    // Fallback robust scan
    if (followers == null || likes == null) {
      async function extractCountsFrom(pg) {
        return await pg.evaluate(() => {
          const arabicDigitMap = {
            '\u0660': '0', '\u0661': '1', '\u0662': '2', '\u0663': '3', '\u0664': '4',
            '\u0665': '5', '\u0666': '6', '\u0667': '7', '\u0668': '8', '\u0669': '9'
          };
          const normalizeDigits = (s) => (s || '')
            .replace(/[\u0660-\u0669]/g, (d) => arabicDigitMap[d] || d)
            .replace(/\u066b/g, '.')
            .replace(/\u066c/g, '');
          
          const toNumberSmart = (raw) => {
            if (!raw) return null;
            let s = normalizeDigits(String(raw)).toLowerCase();
            const m = s.match(/([0-9]+(?:\.[0-9]+)?)(\s*[kmb])?/i);
            if (m) {
              const num = parseFloat(m[1]);
              const suf = (m[2] || '').trim().toLowerCase();
              let factor = 1;
              if (suf === 'k') factor = 1_000;
              else if (suf === 'm') factor = 1_000_000;
              else if (suf === 'b') factor = 1_000_000_000;
              return Math.round(num * factor);
            }
            let factor = 1;
            if (/\b(الف|ألف)\b/.test(s)) factor = 1_000;
            else if (/\b(مليون|ملايين)\b/.test(s)) factor = 1_000_000;
            else if (/\b(مليار|مليارات)\b/.test(s)) factor = 1_000_000_000;
            const numOnly = (s.match(/([0-9]+(?:\.[0-9]+)?)/) || [null, null])[1];
            if (numOnly) return Math.round(parseFloat(numOnly) * factor);
            const digitsOnly = s.replace(/[^0-9]/g, '');
            if (!digitsOnly) return null;
            const n = parseInt(digitsOnly, 10);
            return Number.isFinite(n) ? n : null;
          };

          function extractFromHeaderChips() {
            const root = document.querySelector('div[role="main"]') || document.body;
            const chips = Array.from(root.querySelectorAll('[role="main"] span, [role="main"] div, [role="main"] a'))
              .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
              .filter(Boolean);
            let followers = null;
            let likes = null;
            for (const t of chips) {
              if (/\bيتابع(?:ون)?\b/.test(t)) continue;
              if (/\bالمتابعون\b/i.test(t) || /followers/i.test(t)) {
                const n = toNumberSmart(t);
                if (n != null) followers = Math.max(followers ?? 0, n);
              }
              if (/\b(الإعجابات|الاعجابات|إعجابات|إعجاب|likes)\b/i.test(t)) {
                const n = toNumberSmart(t);
                if (n != null) likes = Math.max(likes ?? 0, n);
              }
            }
            return { followers, likes };
          }

          const headerRes = extractFromHeaderChips();
          const textNodes = Array.from(document.querySelectorAll('body *'))
            .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
            .filter(Boolean);

          let followers = headerRes.followers;
          let likes = headerRes.likes;

          const followerPatterns = [
            /([0-9\u0660-\u0669.,\s]+)\s*(متابع(?:ون|ين)?|followers)\b(?!\s*\p{L}*\s*\u064a?يتابع)/iu,
            /(متابع(?:ون|ين)?|followers)\s*[:：]?\s*([0-9\u0660-\u0669.,\s]+)/iu,
          ];
          const likePatterns = [
            /([0-9\u0660-\u0669.,\s]+)\s*(likes|إعجابات|اعجابات|إعجاب)/iu,
            /(likes|إعجابات|اعجابات|إعجاب)\s*[:：]?\s*([0-9\u0660-\u0669.,\s]+)/iu,
          ];

          function bestMatchFrom(lines, patterns) {
            let best = null;
            for (const line of lines) {
              if (/\bيتابع(?:ون)?\b/i.test(line)) continue;
              for (const rx of patterns) {
                const m = line.match(rx);
                if (m) {
                  const numStr = m[1] && /\d/.test(m[1]) ? m[1] : m[2];
                  const val = toNumberSmart(numStr);
                  if (val != null) {
                    if (best == null || val > best) best = val;
                  }
                }
              }
            }
            return best;
          }

          if (followers == null) followers = bestMatchFrom(textNodes, followerPatterns);
          if (likes == null) likes = bestMatchFrom(textNodes, likePatterns);

          return { followers, likes };
        });
      }

      const res = await extractCountsFrom(page);
      if (followers == null) followers = res.followers;
      if (likes == null) likes = res.likes;

      // Try about page if still missing
      if (!followers || followers < 50) {
        aboutPage = await browser.newPage();
        try {
          await aboutPage.setUserAgent(await page.browser().userAgent());
          const aboutUrl = (FB_PAGE_URL.endsWith('/') ? FB_PAGE_URL.slice(0, -1) : FB_PAGE_URL) + '/about';
          await gotoWithRetry(aboutPage, aboutUrl, { waitUntil: 'networkidle2' });
          const extracted = await extractCountsFrom(aboutPage);
          if (extracted.followers && (!followers || extracted.followers > followers)) followers = extracted.followers;
          if (extracted.likes && (!likes || extracted.likes > likes)) likes = extracted.likes;
        } catch (err) {
          console.warn('About page extraction failed:', err.message);
        } finally {
          if (aboutPage) {
            try {
              await aboutPage.close();
            } catch (e) {
              console.warn('Failed to close about page:', e.message);
            }
            aboutPage = null;
          }
        }
      }
    }

    // Load articles
    async function loadArticles(pg, target = POSTS_TARGET) {
      let lastCount = 0;
      let stalls = 0;
      for (let i = 0; i < SCROLL_MAX_LOOPS; i++) {
        await pg.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        try {
          await pg.keyboard.press('End');
        } catch {}
        try {
          await pg.mouse.wheel({ deltaY: 2000 });
        } catch {}
        await sleep(SCROLL_DELAY_MS);

        await clickSeeMoreInArticles(pg);
        try {
          await closePostOverlay(pg);
        } catch {}

        const count = await pg.$$eval('div[role="article"]', (nodes) => nodes.length);
        if (count >= target) break;
        if (count <= lastCount) {
          stalls += 1;
        } else {
          stalls = 0;
          lastCount = count;
        }
        if (stalls >= SCROLL_STALL_LIMIT) break;
      }
    }

    await loadArticles(page, POSTS_TARGET);

    // Extra safety scroll
    await scrollPageToBottom(page, {
      step: 1800,
      delayMs: Math.max(400, Math.floor(SCROLL_DELAY_MS * 0.5)),
      maxScrolls: 5
    });
    await sleep(600);

    // Expand hidden text
    await clickSeeMoreInArticles(page);
    try {
      await closePostOverlay(page);
    } catch {}
    await sleep(800);

    // Extract posts
    const posts = await page.$$eval('div[role="article"]', (nodes) => {
      const arabicDigits = {
        '\u0660': '0', '\u0661': '1', '\u0662': '2', '\u0663': '3', '\u0664': '4',
        '\u0665': '5', '\u0666': '6', '\u0667': '7', '\u0668': '8', '\u0669': '9'
      };
      const normalizeDigits = (s) => (s || '').replace(/[\u0660-\u0669]/g, (d) => arabicDigits[d] || d);
      
      const toNumber = (raw) => {
        if (!raw) return null;
        let s = normalizeDigits(raw).toLowerCase();
        const mK = s.match(/([0-9]+(?:\.[0-9]+)?)\s*k/);
        const mM = s.match(/([0-9]+(?:\.[0-9]+)?)\s*m/);
        if (mK) return Math.round(parseFloat(mK[1]) * 1000);
        if (mM) return Math.round(parseFloat(mM[1]) * 1000000);
        s = s.replace(/[,\s]/g, '');
        const n = parseInt(s, 10);
        return Number.isFinite(n) ? n : null;
      };

      const cleanText = (t) => {
        if (!t) return '';
        t = t.replace(/عرض المزيد|See more/gi, ' ');
        const splitOn = /(أعجبني|تعليق|مشاركة|Like|Comment|Share)/i;
        const parts = t.split(splitOn);
        return (parts[0] || t).replace(/\s+/g, ' ').trim();
      };

      const extractReactions = (article) => {
        const text = article.innerText || '';
        let m = text.match(/كل\s*التفاعلات\s*[:：]?\s*([0-9\u0660-\u0669,.]+)/);
        if (m) return toNumber(m[1]);

        const labels = Array.from(article.querySelectorAll('[aria-label]')).map((el) => el.getAttribute('aria-label'));
        for (const lbl of labels) {
          if (!lbl) continue;
          if (/أعجبني|تفاع|react|like|likes/i.test(lbl)) {
            const n = (lbl.match(/([0-9\u0660-\u0669,.]+\s*[kKmM]?)/) || [null, null])[1];
            const val = toNumber(n);
            if (val != null) return val;
          }
        }

        const spans = Array.from(article.querySelectorAll('span'))
          .map((s) => s.textContent || '')
          .filter((s) => /[0-9\u0660-\u0669]/.test(s) && /أعجبني|like|تفاع/i.test(text + ' ' + s));
        for (const s of spans) {
          const n = (s.match(/([0-9\u0660-\u0669,.]+\s*[kKmM]?)/) || [null, null])[1];
          const val = toNumber(n);
          if (val != null) return val;
        }

        return null;
      };

      const extractDate = (article) => {
        const timeEl = article.querySelector('time[datetime]') || article.querySelector('a time');
        if (timeEl) {
          const dt = timeEl.getAttribute('datetime') || timeEl.textContent;
          if (dt) return dt.trim();
        }
        const linkWithTime = article.querySelector('a[role="link"][tabindex="0"], a[role="link"]');
        if (linkWithTime) {
          const txt = linkWithTime.textContent || '';
          const m = txt.match(/([0-9\u0660-\u0669]+\s*(?:س|د|ي|h|d|m|y)|\d{1,2}\s+[A-Za-z\u0600-\u06FF]+\s+الساعة\s+\d{1,2}:\d{2}\s*(?:[A-Za-z\u0600-\u06FF]+)?)/u);
          if (m) return m[1];
        }
        const txt = (article.innerText || '').slice(0, 300);
        const m = txt.match(/(\d{1,2}\s+[A-Za-z\u0600-\u06FF]+\s+الساعة\s+\d{1,2}:\d{2}\s*[A-Za-z\u0600-\u06FF]*|[0-9\u0660-\u0669]+\s*(س|د|ي|h|d|m|y))/u);
        return m ? m[1] : null;
      };

      const arr = nodes
        .map((article) => {
          let t = article.innerText || '';
          t = cleanText(t);
          const reactions = extractReactions(article);
          const date = extractDate(article);
          return { text: t, reactions, date };
        })
        .filter((p) => p.text && p.text.length > 0);

      const seen = new Set();
      const unique = [];
      for (const p of arr) {
        const key = p.text;
        if (!seen.has(key)) {
          seen.add(key);
          unique.push(p);
        }
      }
      return unique;
    });

    // Enrich posts
    const enrichedPosts = posts.slice(0, POSTS_TARGET).map((p) => ({
      ...p,
      dateISO: parseDateToISO(p.date) || null,
    }));

    // Build result
    const result = {
      page: pageTitle ? sanitizeText(pageTitle) : null,
      followers,
      likes,
      posts: enrichedPosts,
      scrapedAt: new Date().toISOString(),
      url: FB_PAGE_URL,
      meta: {
        postsTarget: POSTS_TARGET,
        loadedArticles: posts.length,
      },
    };

    // Save to file if enabled
    if (SAVE_TO_FILE) {
      try {
        const outputsDirUrl = saveDir ? new URL(saveDir) : new URL('../outputs/', import.meta.url);
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const outFileUrl = new URL(`facebook-scrape-${ts}.json`, outputsDirUrl);
        await fs.mkdir(fileURLToPath(outputsDirUrl), { recursive: true });
        await fs.writeFile(fileURLToPath(outFileUrl), JSON.stringify(result, null, 2), 'utf-8');
        console.log(`Saved results to: ${fileURLToPath(outFileUrl)}`);
      } catch (err) {
        console.warn('Failed to save to file:', err.message);
      }
    }

    return result;
  } catch (err) {
    console.error('Scraper error:', {
      message: err.message,
      stack: err.stack,
      url: FB_PAGE_URL,
    });
    throw err;
  } finally {
    // Cleanup
    if (aboutPage) {
      try {
        await aboutPage.close();
      } catch (e) {
        console.warn('Failed to close about page in finally:', e.message);
      }
    }
    if (page) {
      try {
        await page.close();
      } catch (e) {
        console.warn('Failed to close main page:', e.message);
      }
    }
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.error('Failed to close browser:', e.message);
      }
    }
  }
}

/**
 * Retry helper for navigation
 */
async function gotoWithRetry(page, url, options = {}, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await page.goto(url, options);
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      console.warn(`Retry ${i + 1}/${maxRetries} for ${url}: ${err.message}`);
      await sleep(1000 * (i + 1));
    }
  }
}

/**
 * Standalone execution (if run directly)
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeFacebookPage({
    FB_PAGE_URL: process.env.FB_PAGE_URL,
    FOLLOWERS_XPATH: process.env.FOLLOWERS_XPATH,
    LIKES_XPATH: process.env.LIKES_XPATH,
    POSTS_TARGET: parseInt(process.env.POSTS_TARGET || '100', 10),
    SCROLL_DELAY_MS: parseInt(process.env.SCROLL_DELAY_MS || '2000', 10),
    SCROLL_STALL_LIMIT: parseInt(process.env.SCROLL_STALL_LIMIT || '10', 10),
    SCROLL_MAX_LOOPS: parseInt(process.env.SCROLL_MAX_LOOPS || '300', 10),
  })
    .then((result) => {
      console.log('Scrape result:');
      console.dir(result, { depth: null, colors: true });
      process.exit(0);
    })
    .catch((err) => {
      console.error('Fatal error:', err);
      process.exit(1);
    });
}
