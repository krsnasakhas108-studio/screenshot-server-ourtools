const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'OurTools Screenshot API',
    version: '1.0.0'
  });
});

// Main screenshot endpoint
app.post('/screenshot', async (req, res) => {
  const {
    url,
    type = 'fullpage',      // fullpage | viewport | element
    width = 1280,
    height = 800,
    format = 'png',          // png | jpeg | webp
    quality = 90,
    delay = 1000,            // ms to wait before screenshot
    mobile = false,
    darkMode = false,
    scale = 1,               // device scale factor
    removeAds = false,
    selector = null,         // CSS selector for element screenshot
  } = req.body;

  // Validate URL
  if (!url) return res.status(400).json({ error: 'URL is required' });

  let formattedUrl = url;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    formattedUrl = 'https://' + url;
  }

  try {
    new URL(formattedUrl);
  } catch(e) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH ||
        '/opt/render/.cache/puppeteer/chrome/linux-120.0.6099.109/chrome-linux64/chrome',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--hide-scrollbars',
        '--metrics-recording-only',
        '--mute-audio',
        '--safebrowsing-disable-auto-update',
      ],
      timeout: 30000,
    });

    const page = await browser.newPage();

    // Set viewport
    const viewportConfig = mobile ? {
      width: 390,
      height: 844,
      deviceScaleFactor: scale || 3,
      isMobile: true,
      hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
    } : {
      width: parseInt(width),
      height: parseInt(height),
      deviceScaleFactor: parseInt(scale) || 1,
      isMobile: false,
    };

    await page.setViewport(viewportConfig);

    if (mobile) {
      await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1');
    }

    // Dark mode
    if (darkMode) {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    }

    // Navigate to URL
    await page.goto(formattedUrl, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // Wait for delay
    if (delay > 0) {
      await new Promise(r => setTimeout(r, Math.min(parseInt(delay), 5000)));
    }

    // Remove ads/banners if requested
    if (removeAds) {
      await page.evaluate(() => {
        const selectors = [
          '[class*="ad"]', '[class*="cookie"]', '[id*="cookie"]',
          '[class*="banner"]', '[class*="popup"]', '[class*="overlay"]',
          '[class*="gdpr"]', '[class*="consent"]', '.ad', '#ad',
          'iframe[src*="ads"]', '[class*="newsletter"]'
        ];
        selectors.forEach(sel => {
          document.querySelectorAll(sel).forEach(el => {
            if (el.offsetHeight < 300) el.style.display = 'none';
          });
        });
      });
    }

    let screenshotBuffer;
    const screenshotOptions = {
      type: format === 'jpg' ? 'jpeg' : format,
      quality: format !== 'png' ? parseInt(quality) : undefined,
      encoding: 'base64',
    };

    if (type === 'fullpage') {
      screenshotOptions.fullPage = true;
      screenshotBuffer = await page.screenshot(screenshotOptions);
    } else if (type === 'viewport') {
      screenshotOptions.fullPage = false;
      screenshotBuffer = await page.screenshot(screenshotOptions);
    } else if (type === 'element' && selector) {
      const element = await page.$(selector);
      if (!element) {
        await browser.close();
        return res.status(404).json({ error: 'Element not found: ' + selector });
      }
      screenshotBuffer = await element.screenshot(screenshotOptions);
    } else {
      screenshotOptions.fullPage = true;
      screenshotBuffer = await page.screenshot(screenshotOptions);
    }

    // Get page info
    const pageInfo = await page.evaluate(() => ({
      title: document.title,
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    }));

    await browser.close();

    res.json({
      success: true,
      image: `data:image/${format === 'jpg' ? 'jpeg' : format};base64,${screenshotBuffer}`,
      format,
      pageInfo,
      url: formattedUrl,
    });

  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    console.error('Screenshot error:', error.message);
    res.status(500).json({
      error: 'Failed to capture screenshot',
      details: error.message
    });
  }
});

// Multi-screenshot endpoint (different sizes at once)
app.post('/multi-screenshot', async (req, res) => {
  const { url, formats = [] } = req.body;

  if (!url) return res.status(400).json({ error: 'URL is required' });

  const defaultFormats = [
    { name: 'Desktop', width: 1280, height: 800, mobile: false, type: 'fullpage' },
    { name: 'Tablet', width: 768, height: 1024, mobile: false, type: 'fullpage' },
    { name: 'Mobile', width: 390, height: 844, mobile: true, type: 'fullpage' },
    { name: 'Viewport', width: 1280, height: 800, mobile: false, type: 'viewport' },
  ];

  const targets = formats.length > 0 ? formats : defaultFormats;

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH ||
        '/opt/render/.cache/puppeteer/chrome/linux-120.0.6099.109/chrome-linux64/chrome',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
        '--disable-extensions',
        '--hide-scrollbars',
        '--mute-audio',
      ],
      timeout: 30000,
    });

    const results = [];

    for (const target of targets) {
      try {
        const page = await browser.newPage();

        await page.setViewport({
          width: target.width,
          height: target.height,
          deviceScaleFactor: target.mobile ? 2 : 1,
          isMobile: target.mobile || false,
        });

        if (target.mobile) {
          await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15');
        }

        await page.goto(url.startsWith('http') ? url : 'https://' + url, {
          waitUntil: 'networkidle2',
          timeout: 25000,
        });

        await new Promise(r => setTimeout(r, 1000));

        const buffer = await page.screenshot({
          fullPage: target.type === 'fullpage',
          type: 'jpeg',
          quality: 85,
          encoding: 'base64',
        });

        const dimensions = await page.evaluate(() => ({
          width: document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight,
        }));

        results.push({
          name: target.name,
          image: `data:image/jpeg;base64,${buffer}`,
          width: target.width,
          height: dimensions.height,
        });

        await page.close();
      } catch(e) {
        results.push({
          name: target.name,
          error: e.message,
        });
      }
    }

    await browser.close();
    res.json({ success: true, results, url });

  } catch(error) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: 'Failed', details: error.message });
  }
});

app.listen(PORT, () => console.log(`Screenshot server running on port ${PORT}`));
