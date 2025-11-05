// src/api-server.js
import 'dotenv/config';
import express from 'express';
import { scrapeFacebookPageOptimized } from './scraper-optimized.js';  // ✅ تأكد من الاسم الصحيح


const app = express();
app.use(express.json());

// ✅ CORS headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

const PORT = process.env.API_PORT || 3000;

/**
 * POST /api/scrape - Scrape a Facebook page
 * Body: { pageUrl, postsTarget, scrollDelayMs }
 */
app.post('/api/scrape', async (req, res) => {
  try {
    const { pageUrl, postsTarget = 10, scrollDelayMs = 3000 } = req.body;

    if (!pageUrl) {
      return res.status(400).json({
        success: false,
        error: 'pageUrl is required in request body',
        example: {
          pageUrl: 'https://www.facebook.com/pagename',
          postsTarget: 10,
          scrollDelayMs: 3000
        }
      });
    }

    console.log(`[API] 🚀 Starting scrape for: ${pageUrl}`);
    console.log(`[API] 📊 Target posts: ${postsTarget}`);

    const result = await scrapeFacebookPageOptimized({
      FB_PAGE_URL: pageUrl,
      POSTS_TARGET: postsTarget,
      SCROLL_DELAY_MS: scrollDelayMs,
      SAVE_TO_FILE: false,
    });

    console.log(`[API] ✅ Scrape completed! Found ${result.posts.length} posts`);

    res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    console.error('[API] ❌ Error:', err.message);
    res.status(500).json({
      success: false,
      error: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    });
  }
});

/**
 * GET /health - Health check
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    message: 'API Server is running'
  });
});

/**
 * GET /api/info - API Information
 */
app.get('/api/info', (req, res) => {
  res.json({
    name: 'Facebook Scraper API',
    version: '1.0.0',
    endpoints: [
      {
        method: 'POST',
        path: '/api/scrape',
        description: 'Scrape Facebook page posts with engagement metrics',
        body: {
          pageUrl: 'string (required)',
          postsTarget: 'number (default: 10)',
          scrollDelayMs: 'number (default: 3000)'
        },
        response: {
          page: { name: 'string', url: 'string' },
          posts: [
            {
              id: 'number',
              text: 'string',
              reactions: 'number',
              comments: 'number',
              shares: 'number',
              total_engagement: 'number',
              date: 'string'
            }
          ],
          summary: {
            total_posts: 'number',
            total_reactions: 'number',
            total_comments: 'number',
            total_shares: 'number',
            avg_reactions: 'number',
            avg_comments: 'number',
            avg_shares: 'number',
            best_post: 'object'
          },
          scraped_at: 'string'
        }
      },
      { method: 'GET', path: '/health', description: 'Health check' },
      { method: 'GET', path: '/api/info', description: 'API documentation' }
    ]
  });
});

app.listen(PORT, () => {
  console.log(`\n🚀 API Server running on http://localhost:${PORT}`);
  console.log(`📍 POST /api/scrape - Scrape a Facebook page`);
  console.log(`❤️  GET /health - Health check`);
  console.log(`ℹ️  GET /api/info - API documentation\n`);
});
