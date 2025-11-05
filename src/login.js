// src/login.js
import 'dotenv/config';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { waitAndType, waitAndClick, clickIfExists } from './utils.js';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';

puppeteer.use(StealthPlugin());

const cookiesFilePath = fileURLToPath(new URL('../cookies.json', import.meta.url));

async function loadCookies(page) {
  try {
    const data = await fs.readFile(cookiesFilePath, 'utf-8');
    const cookies = JSON.parse(data);
    if (Array.isArray(cookies) && cookies.length) {
      await page.setCookie(...cookies);
      console.log('Loaded cookies from cookies.json');
    }
  } catch (_) {
    // No cookies file yet
  }
}

async function saveCookies(page) {
  try {
    const cookies = await page.cookies();
    await fs.writeFile(cookiesFilePath, JSON.stringify(cookies, null, 2), 'utf-8');
    console.log('Saved cookies to cookies.json');
  } catch (err) {
    console.warn('Failed to save cookies:', err);
  }
}

async function isLoggedInHeuristic(page) {
  return await page.evaluate(() => {
    return !!document.querySelector('a[aria-label="Profile"], a[aria-label="Your profile"], div[role="feed"]');
  });
}

/**
 * Launch browser and log into Facebook using credentials in .env
 * Returns: { browser, page }
 */
export async function login() {
  const { FB_EMAIL, FB_PASSWORD } = process.env;
  if (!FB_EMAIL || !FB_PASSWORD) {
    throw new Error('FB_EMAIL and FB_PASSWORD must be set in .env');
  }

  const browser = await puppeteer.launch({
    headless: 'new',  // ✅ headless mode الحديث (أسرع)
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',  // تعطيل GPU
      '--single-process'  // thread واحد بس
    ]
  });

  const page = await browser.newPage();

  // Helpful: realistic user agent
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  // Try loading cookies first and go to home to validate session
  await loadCookies(page);
  await page.goto('https://www.facebook.com/', { waitUntil: 'networkidle2' });
  let loggedIn = await isLoggedInHeuristic(page);

  if (!loggedIn) {
    // Navigate to Facebook login
    await page.goto('https://www.facebook.com/login', { waitUntil: 'networkidle2' });

    // Try dismiss cookie banners if present (varies by region)
    await clickIfExists(page, 'button[data-cookiebanner="accept_only_essential_button"]');
    await clickIfExists(page, 'button[title="Only allow essential cookies"]');
    await clickIfExists(page, 'button[title="Allow all cookies"]');

    // Fill credentials and submit
    await waitAndType(page, 'input[name="email"]', FB_EMAIL);
    await waitAndType(page, 'input[name="pass"]', FB_PASSWORD);
    await waitAndClick(page, 'button[name="login"]');

    // Wait for either home/newsfeed or any post-login state
    try {
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
    } catch (_) {
      // Sometimes FB stays on same URL but shows logged-in content; ignore timeout
    }

    loggedIn = await isLoggedInHeuristic(page);
    if (!loggedIn) {
      console.warn('Login may not have been confirmed, proceeding anyway.');
    }

    // Save cookies after login attempt
    await saveCookies(page);
  } else {
    console.log('Logged in using existing cookies.');
  }

  return { browser, page };
}
