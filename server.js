const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'OurTools Screenshot API', version: '3.0.0' });
});

async function getBrowser() {
  const puppeteer = require('puppeteer');

  // Find Chrome executable
  let executablePath;
  try {
    executablePath = puppeteer.executablePath();
    console.log('Chrome path:', executablePath);
  } catch(e) {
    console.log('Could not find Chrome automatically, trying manual paths...');
    const possiblePaths = [
      '/opt/render/.cache/puppeteer/chrome/linux-121.0.6167.85/chrome-linux64/chrome',
      '/opt/render/.cache/puppeteer/chrome/linux-120.0.6099.109/chrome-linux64/chrome',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
    ];
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        executablePath = p;
        console.log('Found Chrome at:', p);
        break;
      }
    }
  }

  return puppeteer.launch({
    headless: 'new',
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
    ],
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
  console.log('Screenshot:', formattedUrl);

  let browser;
  try {
    browser = await getBrowser();
    const page = await browser.newPage();

    await page.setViewport({
      width: parseInt(width) || 1280,
      height: parseInt(height) || 800,
      deviceScaleFactor: parseInt(scale) || 1,
      isMobile: mobile === true || mobile === 'true',
    });

    if (mobile) {
      await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1');
    }

    if (darkMode) {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    }

    await page.goto(formattedUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, Math.min(parseInt(delay) || 1000, 3000)));

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
      type: format === 'jpg' ? 'jpeg' : (format || 'jpeg'),
      encoding: 'base64',
      fullPage: type !== 'viewport',
    };
    if (format !== 'png') screenshotOptions.quality = parseInt(quality) || 85;

    let buffer;
    if (type === 'element' && selector) {
      const el = await page.$(selector);
      if (!el) { await browser.close(); return res.status(404).json({ error: 'Element not found' }); }
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
    console.log('Screenshot success!');

    res.json({
      success: true,
      image: `data:image/${format === 'jpg' ? 'jpeg' : (format || 'jpeg')};base64,${buffer}`,
      format: format || 'jpeg',
      pageInfo,
      url: formattedUrl,
    });

  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    console.error('Error:', error.message);
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
    const formattedUrl = url.startsWith('http') ? url : 'https://' + url;

    for (const target of targets) {
      try {
        const page = await browser.newPage();
        await page.setViewport({ width: target.width, height: target.height, isMobile: target.mobile, deviceScaleFactor: target.mobile ? 2 : 1 });
        if (target.mobile) await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15');
        await page.goto(formattedUrl, { waitUntil: 'networkidle2', timeout: 25000 });
        await new Promise(r => setTimeout(r, 1000));
        const buffer = await page.screenshot({ fullPage: !target.viewport, type: 'jpeg', quality: 80, encoding: 'base64' });
        const dims = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
        results.push({ name: target.name, image: `data:image/jpeg;base64,${buffer}`, width: target.width, height: dims.height });
        await page.close();
      } catch(e) {
        results.push({ name: target.name, error: e.message });
      }
    }

    await browser.close();
    res.json({ success: true, results, url: formattedUrl });
  } catch(error) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: 'Failed', details: error.message });
  }
});

app.post('/lock-pdf', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PDF file' });
  const password = req.body.password;
  if (!password) return res.status(400).json({ error: 'Password required' });

  const tmpDir = os.tmpdir();
  const inputPath = path.join(tmpDir, `input_${Date.now()}.pdf`);
  const outputPath = path.join(tmpDir, `locked_${Date.now()}.pdf`);

  try {
    fs.writeFileSync(inputPath, req.file.buffer);

    // Try qpdf
    let qpdfOk = false;
    try {
      execSync('which qpdf', { stdio: 'ignore' });
      qpdfOk = true;
    } catch(e) {
      try {
        execSync('apt-get install -y qpdf 2>/dev/null || true', { stdio: 'ignore', timeout: 30000 });
        execSync('which qpdf', { stdio: 'ignore' });
        qpdfOk = true;
      } catch(e2) {}
    }

    if (qpdfOk) {
      execSync(`qpdf --encrypt "${password}" "${password}" 256 -- "${inputPath}" "${outputPath}"`);
    } else {
      // Fallback: pdf-lib
      const { PDFDocument } = require('pdf-lib');
      const pdfBytes = fs.readFileSync(inputPath);
      const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
      const locked = await pdfDoc.save({
        userPassword: password,
        ownerPassword: password + '_owner',
      });
      fs.writeFileSync(outputPath, locked);
    }

    const resultBytes = fs.readFileSync(outputPath);
    try { fs.unlinkSync(inputPath); } catch(e) {}
    try { fs.unlinkSync(outputPath); } catch(e) {}

    res.json({
      success: true,
      pdf: `data:application/pdf;base64,${resultBytes.toString('base64')}`,
      size: resultBytes.length,
      method: qpdfOk ? 'qpdf-aes256' : 'pdf-lib',
    });

  } catch(e) {
    try { fs.unlinkSync(inputPath); } catch(err) {}
    try { fs.unlinkSync(outputPath); } catch(err) {}
    res.status(500).json({ error: 'Failed to lock PDF', details: e.message });
  }
});

// Self-ping to prevent Render free tier from sleeping
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
setInterval(async () => {
  try {
    const http = require('http');
    const https = require('https');
    const client = SELF_URL.startsWith('https') ? https : http;
    client.get(SELF_URL + '/', () => {
      console.log('Keep-alive ping sent');
    }).on('error', () => {});
  } catch(e) {}
}, 14 * 60 * 1000); // Every 14 minutes

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
