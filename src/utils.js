// src/utils.js
// Utilities to help with common Puppeteer actions

/** Simple sleep helper to await for ms milliseconds */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Normalize Arabic-Indic digits to Latin digits
const arabicDigitMap = {
  '\u0660': '0', '\u0661': '1', '\u0662': '2', '\u0663': '3', '\u0664': '4',
  '\u0665': '5', '\u0666': '6', '\u0667': '7', '\u0668': '8', '\u0669': '9',
};
function normalizeArabicDigits(s) {
  return (s || '').replace(/[\u0660-\u0669]/g, (d) => arabicDigitMap[d] || d);
}

/**
 * Parse a textual count like "2.3K", "1M", or Arabic forms like "٢٫٨ ألف" into a number.
 * Returns integer or null when not parsable.
 */
export function parseCount(text) {
  if (!text) return null;
  let s = normalizeArabicDigits(String(text)).trim().toLowerCase();
  // Normalize Arabic decimal/thousand separators
  s = s.replace(/\u066b/g, '.').replace(/\u066c/g, '');

  // Map Arabic magnitude words
  let factor = 1;
  if (/\b(الف|ألف)\b/.test(s)) factor = 1_000;
  else if (/\b(مليون|ملايين)\b/.test(s)) factor = 1_000_000;
  else if (/\b(مليار|مليارات)\b/.test(s)) factor = 1_000_000_000;
  else if (/\bk\b/.test(s)) factor = 1_000;
  else if (/\bm\b/.test(s)) factor = 1_000_000;
  else if (/\bb\b/.test(s)) factor = 1_000_000_000;

  // Extract first numeric token
  const m = s.match(/([0-9]+(?:\.[0-9]+)?)/);
  if (!m) {
    const digitsOnly = s.replace(/[^0-9]/g, '');
    if (!digitsOnly) return null;
    const n = parseInt(digitsOnly, 10);
    return Number.isFinite(n) ? n : null;
  }
  const num = parseFloat(m[1]);
  const val = Math.round(num * factor);
  return Number.isFinite(val) ? val : null;
}

/**
 * Parse relative/Arabic date strings to ISO (best-effort).
 * Examples: "١٨ س" => now - 18h, "3d" => now - 3 days,
 * "14 سبتمبر الساعة 6:00 م" => absolute with Arabic month/period.
 */
export function parseDateToISO(dateStr) {
  if (!dateStr) return null;
  let s = normalizeArabicDigits(String(dateStr)).trim();

  // If already ISO-like
  if (/\d{4}-\d{2}-\d{2}T\d{2}:/i.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  const now = new Date();
  // Relative forms: number + unit (ar/en)
  const rel = s.match(/([0-9]+)\s*(س|ساعة|h|سا|د|دقيقة|m|ي|يوم|d|y|سنة)/i);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    const d = new Date(now);
    if (['س', 'ساعة', 'h', 'سا'].includes(unit)) d.setHours(d.getHours() - n);
    else if (['د', 'دقيقة', 'm'].includes(unit)) d.setMinutes(d.getMinutes() - n);
    else if (['ي', 'يوم', 'd'].includes(unit)) d.setDate(d.getDate() - n);
    else if (['y', 'سنة'].includes(unit)) d.setFullYear(d.getFullYear() - n);
    return d.toISOString();
  }

  // Absolute Arabic form: "14 سبتمبر الساعة 6:00 م"
  const months = {
    'يناير': 0, 'فبراير': 1, 'مارس': 2, 'أبريل': 3, 'ابريل': 3, 'أيار': 4, 'مايو': 4,
    'يونيو': 5, 'يوليو': 6, 'أغسطس': 7, 'اغسطس': 7, 'سبتمبر': 8, 'أكتوبر': 9, 'اكتوبر': 9,
    'نوفمبر': 10, 'ديسمبر': 11,
  };
  const abs = s.match(/(\d{1,2})\s+(\p{L}+)\s+الساعة\s+(\d{1,2}):(\d{2})\s*(ص|م)?/u);
  if (abs) {
    const day = parseInt(abs[1], 10);
    const monName = abs[2];
    const hour = parseInt(abs[3], 10);
    const minute = parseInt(abs[4], 10);
    const period = (abs[5] || '').trim();
    const month = months[monName];
    if (month != null) {
      let h = hour % 12;
      if (period === 'م') h += 12; // PM
      // Assume current year and local timezone
      const d = new Date();
      d.setMonth(month);
      d.setDate(day);
      d.setHours(h, minute, 0, 0);
      return d.toISOString();
    }
  }

  // Fallback: return null when cannot parse
  return null;
}

/**
 * Wait for a selector to appear and type text.
 */
export async function waitAndType(page, selector, text, opts = {}) {
  const { timeout = 15000, delay = 20, clear = true } = opts;
  await page.waitForSelector(selector, { visible: true, timeout });
  if (clear) {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.value = '';
    }, selector);
  }
  await page.type(selector, text, { delay });
}

/**
 * Wait for a selector to be clickable and click it.
 */
export async function waitAndClick(page, selector, opts = {}) {
  const { timeout = 15000, delay = 20 } = opts;
  await page.waitForSelector(selector, { visible: true, timeout });
  await page.click(selector, { delay });
}

/**
 * Click an element if it exists (no throw).
 */
export async function clickIfExists(page, selector) {
  const el = await page.$(selector);
  if (el) {
    await el.click();
    return true;
  }
  return false;
}

/** Auto-click "See more/عرض المزيد" inside each article to expand text */
export async function clickSeeMoreInArticles(page) {
  await page.evaluate(() => {
    const matches = (t) => /عرض المزيد|see more/i.test(t || '');
    const articles = document.querySelectorAll('div[role="article"]');
    for (const art of articles) {
      // Restrict to elements that act as inline expanders, not navigation links
      const clickable = art.querySelectorAll('button, span[role="button"], div[role="button"], span[aria-label], div[aria-label]');
      for (const el of clickable) {
        const txt = (el.innerText || el.textContent || '').trim();
        // Skip anchors or elements inside anchors to avoid opening the post overlay
        if (txt && matches(txt)) {
          const isAnchor = (node) => node && (node.tagName === 'A');
          if (isAnchor(el) || el.closest('a')) continue;
          try { if (typeof el.click === 'function') el.click(); } catch {}
        }
      }
    }
  });
}

/** Try to close an open post overlay/dialog if present */
export async function closePostOverlay(page) {
  try {
    // If a dialog is present, try known close controls
    const hasDialog = await page.$('div[role="dialog"], [aria-modal="true"]');
    if (!hasDialog) return false;

    const selectors = [
      'div[role="dialog"] [aria-label="Close"]',
      'div[role="dialog"] [aria-label="إغلاق"]',
      'div[role="dialog"] [data-testid="close-button"]',
      'div[role="dialog"] [role="button"][tabindex="0"]',
      'div[role="dialog"] button',
    ];

    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) { try { await el.click(); await page.waitForTimeout(200); } catch {} }
      const stillOpen = await page.$('div[role="dialog"], [aria-modal="true"]');
      if (!stillOpen) return true;
    }

    // Fallback: press Escape to close
    try { await page.keyboard.press('Escape'); await page.waitForTimeout(200); } catch {}
    const remains = await page.$('div[role="dialog"], [aria-modal="true"]');
    return !remains;
  } catch {
    return false;
  }
}

/**
 * Get trimmed innerText of a selector, or null if missing.
 */
export async function getText(page, selector) {
  const el = await page.$(selector);
  if (!el) return null;
  const text = await page.evaluate((node) => node.innerText, el);
  return text?.trim() || null;
}

/**
 * Find first element whose textContent matches a regex and return its full text.
 */
export async function findTextByRegex(page, regexSource, flags = 'i') {
  const res = await page.evaluate((source, flags) => {
    const rx = new RegExp(source, flags);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      const txt = node.textContent || '';
      if (rx.test(txt)) {
        return txt.trim();
      }
    }
    return null;
  }, regexSource, flags);
  return res;
}

/**
 * Scroll the page to the bottom gradually to trigger lazy content.
 */
export async function scrollPageToBottom(page, { step = 600, delayMs = 200, maxScrolls = 20 } = {}) {
  for (let i = 0; i < maxScrolls; i++) {
    const finished = await page.evaluate((s) => {
      const { scrollTop, scrollHeight, clientHeight } = document.scrollingElement || document.documentElement;
      const next = Math.min(scrollTop + s, scrollHeight);
      window.scrollTo(0, next);
      return next + clientHeight >= scrollHeight;
    }, step);
    if (finished) break;
    await sleep(delayMs);
  }
}

/**
 * Sanitize multi-line text.
 */
export function sanitizeText(s) {
  return (s || '')
    .replace(/\u200b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
