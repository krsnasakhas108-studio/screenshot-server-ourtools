const express = require('express');
const cors = require('cors');
const chromium = require('chrome-aws-lambda');
const puppeteer = require('puppeteer-core');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'OurTools Screenshot API', version: '2.0.0' });
});

async function getBrowser() {
  return puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath,
    headless: chromium.headless,
  });
}

app.post('/screenshot', async (req, res) => {
  const {
    url, type = 'fullpage', width = 1280, height = 800,
    format = 'jpeg', quality = 85, delay = 1000,
    mobile = false, darkMode = false, scale = 1,
    removeAds = false, selector = null,
  } = req.body;

  if (!url) return res.status(400).json({ error: 'URL is required' });
  const formattedUrl = url.startsWith('http') ? url : 'https://' + url;

  let browser;
  try {
    browser = await getBrowser();
    const page = await browser.newPage();

    await page.setViewport({
      width: parseInt(width),
      height: parseInt(height),
      deviceScaleFactor: parseInt(scale) || 1,
      isMobile: mobile,
    });

    if (mobile) {
      await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1');
    }

    if (darkMode) {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    }

    await page.goto(formattedUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, Math.min(parseInt(delay), 3000)));

    if (removeAds) {
      await page.evaluate(() => {
        ['[class*="cookie"]','[id*="cookie"]','[class*="banner"]','[class*="popup"]','[class*="gdpr"]','[class*="consent"]'].forEach(sel => {
          document.querySelectorAll(sel).forEach(el => {
            if (el.offsetHeight < 300) el.style.display = 'none';
          });
        });
      });
    }

    const screenshotOptions = {
      type: format === 'jpg' ? 'jpeg' : format,
      quality: format !== 'png' ? parseInt(quality) : undefined,
      encoding: 'base64',
      fullPage: type === 'fullpage',
    };

    let buffer;
    if (type === 'element' && selector) {
      const el = await page.$(selector);
      if (!el) {
        await browser.close();
        return res.status(404).json({ error: 'Element not found: ' + selector });
      }
      buffer = await el.screenshot(screenshotOptions);
    } else {
      buffer = await page.screenshot(screenshotOptions);
    }

    const pageInfo = await page.evaluate(() => ({
      title: document.title,
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    }));

    await browser.close();

    res.json({
      success: true,
      image: `data:image/${format === 'jpg' ? 'jpeg' : format};base64,${buffer}`,
      format, pageInfo, url: formattedUrl,
    });

  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: 'Screenshot failed', details: error.message });
  }
});

app.post('/multi-screenshot', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  const targets = [
    { name: 'Desktop', width: 1280, height: 800, mobile: false },
    { name: 'Tablet', width: 768, height: 1024, mobile: false },
    { name: 'Mobile', width: 390, height: 844, mobile: true },
    { name: 'Viewport', width: 1280, height: 800, mobile: false, viewport: true },
  ];

  let browser;
  try {
    browser = await getBrowser();
    const results = [];

    for (const target of targets) {
      try {
        const page = await browser.newPage();
        await page.setViewport({
          width: target.width,
          height: target.height,
          isMobile: target.mobile,
          deviceScaleFactor: target.mobile ? 2 : 1,
        });
        if (target.mobile) {
          await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15');
        }
        const formattedUrl = url.startsWith('http') ? url : 'https://' + url;
        await page.goto(formattedUrl, { waitUntil: 'networkidle2', timeout: 25000 });
        await new Promise(r => setTimeout(r, 1000));

        const buffer = await page.screenshot({
          fullPage: !target.viewport,
          type: 'jpeg',
          quality: 80,
          encoding: 'base64',
        });

        const dims = await page.evaluate(() => ({
          width: document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight,
        }));

        results.push({
          name: target.name,
          image: `data:image/jpeg;base64,${buffer}`,
          width: target.width,
          height: dims.height,
        });

        await page.close();
      } catch(e) {
        results.push({ name: target.name, error: e.message });
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
