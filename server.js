const express = require('express');
const cors = require('cors');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'OurTools Screenshot API', version: '2.0.0' });
});

async function getBrowser() {
  try {
    // Try chrome-aws-lambda first
    const chromium = require('chrome-aws-lambda');
    const puppeteer = require('puppeteer-core');

    console.log('Executable path:', await chromium.executablePath);

    return await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath,
      headless: chromium.headless,
    });
  } catch(e) {
    console.error('chrome-aws-lambda failed:', e.message);
    throw new Error('Browser unavailable: ' + e.message);
  }
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
  console.log('Taking screenshot of:', formattedUrl);

  let browser;
  try {
    browser = await getBrowser();
    console.log('Browser launched successfully');

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

    console.log('Navigating to:', formattedUrl);
    await page.goto(formattedUrl, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

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

    if (format !== 'png') {
      screenshotOptions.quality = parseInt(quality) || 85;
    }

    console.log('Taking screenshot with options:', screenshotOptions);
    const buffer = await page.screenshot(screenshotOptions);

    const pageInfo = await page.evaluate(() => ({
      title: document.title,
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    }));

    await browser.close();
    console.log('Screenshot successful!');

    res.json({
      success: true,
      image: `data:image/${format === 'jpg' ? 'jpeg' : (format || 'jpeg')};base64,${buffer}`,
      format: format || 'jpeg',
      pageInfo,
      url: formattedUrl,
    });

  } catch (error) {
    console.error('Screenshot error:', error);
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({
      error: 'Screenshot failed',
      details: error.message,
      stack: error.stack?.split('\n').slice(0,3).join(' | ')
    });
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
        await page.setViewport({
          width: target.width,
          height: target.height,
          isMobile: target.mobile,
          deviceScaleFactor: target.mobile ? 2 : 1,
        });
        if (target.mobile) {
          await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15');
        }
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
        console.error(`Failed ${target.name}:`, e.message);
        results.push({ name: target.name, error: e.message });
      }
    }

    await browser.close();
    res.json({ success: true, results, url: formattedUrl });

  } catch(error) {
    console.error('Multi screenshot error:', error);
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: 'Failed', details: error.message });
  }
});

// ===== PDF LOCK ENDPOINT =====
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

let qpdfAvailable = false;
try {
  execFileSync('qpdf', ['--version'], { stdio: 'ignore' });
  qpdfAvailable = true;
  console.log('qpdf is available');
} catch(e) {
  console.log('qpdf not available, will use pdf-lib fallback');
}

app.post('/lock-pdf', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PDF file provided' });

  const password = req.body.password;
  if (!password) return res.status(400).json({ error: 'Password required' });

  // Validate password — no null bytes, reasonable length
  if (password.length > 128 || /[\x00-\x1f]/.test(password)) {
    return res.status(400).json({ error: 'Invalid password' });
  }

  const tmpDir = os.tmpdir();
  const inputPath = path.join(tmpDir, `input_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`);
  const outputPath = path.join(tmpDir, `locked_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`);

  try {
    fs.writeFileSync(inputPath, req.file.buffer);

    if (qpdfAvailable) {
      // execFileSync with array args — no shell, no injection risk
      execFileSync('qpdf', ['--encrypt', password, password, '256', '--', inputPath, outputPath]);
    } else {
      // pdf-lib fallback (RC4-128, works in all readers)
      const { PDFDocument } = require('pdf-lib');
      const pdfDoc = await PDFDocument.load(fs.readFileSync(inputPath), { ignoreEncryption: true });
      const locked = await pdfDoc.save({
        userPassword: password,
        ownerPassword: password + '_' + Math.random().toString(36).slice(2),
      });
      fs.writeFileSync(outputPath, locked);
    }

    const resultBytes = fs.readFileSync(outputPath);
    const base64 = resultBytes.toString('base64');

    fs.unlinkSync(inputPath);
    fs.unlinkSync(outputPath);

    console.log('PDF locked, size:', resultBytes.length);
    res.json({
      success: true,
      pdf: `data:application/pdf;base64,${base64}`,
      size: resultBytes.length,
    });

  } catch(e) {
    try { fs.unlinkSync(inputPath); } catch(_) {}
    try { fs.unlinkSync(outputPath); } catch(_) {}
    console.error('Lock PDF error:', e);
    res.status(500).json({ error: 'Failed to lock PDF', details: e.message });
  }
});

app.listen(PORT, () => console.log(`Screenshot server running on port ${PORT}`));
