const express = require('express');
const cors = require('cors');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

// ============================================================
// Browser lifecycle — ONE shared instance, reused across requests
// ============================================================

let browserPromise = null;

function findExecutablePath() {
  const puppeteer = require('puppeteer');

  // 1. Ask puppeteer directly (respects .puppeteerrc.cjs / PUPPETEER_CACHE_DIR)
  try {
    const p = puppeteer.executablePath();
    if (p && fs.existsSync(p)) return p;
    console.warn('puppeteer.executablePath() returned a path that does not exist:', p);
  } catch (e) {
    console.warn('puppeteer.executablePath() threw:', e.message);
  }

  // 2. Scan known cache directories for whatever build actually got installed,
  //    instead of guessing an exact Chrome version number.
  const candidateCacheDirs = [
    process.env.PUPPETEER_CACHE_DIR,
    path.join(__dirname, '.cache', 'puppeteer'),
    '/opt/render/project/src/.cache/puppeteer',
    '/opt/render/.cache/puppeteer',
    path.join(os.homedir(), '.cache', 'puppeteer'),
  ].filter(Boolean);

  for (const cacheDir of candidateCacheDirs) {
    const chromeDir = path.join(cacheDir, 'chrome');
    if (!fs.existsSync(chromeDir)) continue;
    try {
      for (const versionDir of fs.readdirSync(chromeDir)) {
        const base = path.join(chromeDir, versionDir);
        const possible = [
          path.join(base, 'chrome-linux64', 'chrome'),
          path.join(base, 'chrome-linux', 'chrome'),
          path.join(base, 'chrome-win64', 'chrome.exe'),
          path.join(base, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        ];
        for (const p of possible) {
          if (fs.existsSync(p)) {
            console.log('Found Chrome via cache scan:', p);
            return p;
          }
        }
      }
    } catch (e) { /* unreadable dir, skip */ }
  }

  // 3. System-installed browsers, if any.
  for (const p of ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium']) {
    if (fs.existsSync(p)) {
      console.log('Found system Chrome at:', p);
      return p;
    }
  }

  // 4. Last resort: @sparticuz/chromium, a Chromium build packaged for
  //    constrained/containerized hosts. Only required if the above all fail.
  try {
    const chromium = require('@sparticuz/chromium');
    console.log('Falling back to @sparticuz/chromium');
    return chromium.executablePath();
  } catch (e) {
    console.warn('@sparticuz/chromium fallback unavailable:', e.message);
  }

  return undefined; // let puppeteer.launch() make one final attempt on its own
}

async function launchBrowser() {
  const puppeteer = require('puppeteer');
  const executablePath = findExecutablePath();

  return puppeteer.launch({
    headless: 'new',
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--disable-gpu',
      // NOTE: --single-process and --no-zygote were removed. They're often
      // recommended for low-memory free-tier hosts, but were directly tested
      // here and reproducibly broke Chrome's own network stack
      // (net::ERR_SSL_BAD_RECORD_MAC_ALERT / ERR_NAME_NOT_RESOLVED on every
      // navigation) even when Chrome itself launched fine. The singleton
      // browser reuse below (one Chrome process for the whole server's
      // lifetime, not one per request) is the safer way to control memory
      // use on a constrained instance.
    ],
  });
}

// Returns a connected browser, launching one if needed and relaunching if
// the previous instance crashed/disconnected.
async function getBrowser() {
  if (browserPromise) {
    try {
      const b = await browserPromise;
      if (b.isConnected()) return b;
      console.warn('Cached browser disconnected, relaunching...');
    } catch (e) {
      console.warn('Cached browser launch had failed, relaunching...', e.message);
    }
    browserPromise = null;
  }
  browserPromise = launchBrowser();
  return browserPromise;
}

// Force the next getBrowser() call to launch a fresh instance. Chrome's
// network stack can end up in a bad state (TLS/socket errors) while the
// DevTools connection itself stays up, so isConnected() alone doesn't
// catch it — a browser that keeps producing net::ERR_* failures needs to
// be thrown away and relaunched, not silently reused forever.
async function invalidateBrowser(reason) {
  console.warn('Invalidating browser instance:', reason);
  const prev = browserPromise;
  browserPromise = null;
  if (prev) {
    try {
      const b = await prev;
      await b.close();
    } catch (e) { /* already dead, nothing to close */ }
  }
}

function looksLikeBrowserNetworkFault(message) {
  return /net::ERR_/.test(message || '');
}

// ============================================================
// SSRF protection — reject non-http(s) URLs and private/internal targets
// ============================================================

function isPrivateOrReservedIP(ip) {
  if (net.isIP(ip) === 0) return true; // unparseable -> treat as unsafe

  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 127) return true;               // loopback
    if (a === 10) return true;                 // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true;   // private
    if (a === 169 && b === 254) return true;   // link-local (incl. cloud metadata 169.254.169.254)
    if (a === 0) return true;                  // "this network"
    if (a >= 224) return true;                 // multicast / reserved
    return false;
  }

  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80')) return true;   // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local fc00::/7
  if (lower.startsWith('::ffff:')) return isPrivateOrReservedIP(lower.split(':').pop()); // IPv4-mapped
  return false;
}

const BLOCKED_HOSTNAMES = new Set(['localhost', '0.0.0.0', 'metadata.google.internal']);

// Only add a scheme when the input has none at all — a bare "example.com"
// becomes "https://example.com", but "file:///etc/passwd" or "ftp://x" are
// passed through unchanged so assertPublicHttpUrl's protocol check can
// reject them with an accurate message instead of "https://" getting
// blindly glued onto an already-schemed (and already-wrong) URL.
function normalizeUrlInput(rawUrl) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawUrl) ? rawUrl : 'https://' + rawUrl;
}

async function assertPublicHttpUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch (e) {
    throw Object.assign(new Error('That does not look like a valid URL.'), { status: 400 });
  }
  if (!['http:', 'https:'].includes(u.protocol)) {
    throw Object.assign(new Error('Only http:// and https:// URLs are allowed.'), { status: 400 });
  }
  const hostname = u.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')) {
    throw Object.assign(new Error('Requests to localhost are not allowed.'), { status: 400 });
  }
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch (e) {
    throw Object.assign(new Error('Could not resolve that hostname.'), { status: 400 });
  }
  if (addresses.some(a => isPrivateOrReservedIP(a.address))) {
    throw Object.assign(new Error('Requests to private or internal network addresses are not allowed.'), { status: 400 });
  }
  return u.toString();
}

// Per-request-interception check used to also cover redirects mid-navigation
// (the up-front assertPublicHttpUrl check above only covers the initial URL).
async function isRequestToBlockedTarget(url) {
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return true;
    const hostname = u.hostname.toLowerCase();
    if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')) return true;
    const addresses = await dns.lookup(hostname, { all: true }).catch(() => []);
    return addresses.some(a => isPrivateOrReservedIP(a.address));
  } catch (e) {
    return true; // fail closed
  }
}

// ============================================================
// Ad / tracker / cookie-banner handling
// ============================================================

const AD_TRACKER_HOSTS = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'google-analytics.com',
  'googletagmanager.com', 'adservice.google.com', 'connect.facebook.net', 'facebook.com/tr',
  'amazon-adsystem.com', 'criteo.com', 'taboola.com', 'outbrain.com', 'adnxs.com',
  'scorecardresearch.com', 'quantserve.com', 'moatads.com', 'adsrvr.org', 'hotjar.com',
  'clarity.ms', 'pixel.wp.com', 'bat.bing.com', 'ads-twitter.com', 'analytics.tiktok.com',
];

function isAdOrTrackerRequest(url) {
  return AD_TRACKER_HOSTS.some(host => url.includes(host));
}

const COOKIE_BANNER_CSS = `
  #onetrust-banner-sdk, #onetrust-consent-sdk, .onetrust-pc-dark-filter,
  #CybotCookiebotDialog, #CybotCookiebotDialogBodyUnderlay,
  .cc-window, .cc-banner, #cookie-banner, .cookie-banner, .cookie-consent,
  #cookieConsent, .gdpr-banner, .gdpr-consent, #gdpr-consent-banner,
  [class*="cookie-notice" i], [id*="cookie-notice" i],
  [class*="cookie-popup" i], [id*="cookie-popup" i],
  [aria-label*="cookie" i][role="dialog"], [aria-label*="consent" i][role="dialog"]
  { display: none !important; visibility: hidden !important; }
  html, body { overflow: auto !important; }
`;

// ============================================================
// Misc helpers
// ============================================================

const DEVICE_PRESETS = {
  desktop: { width: 1920, height: 1080, mobile: false },
  tablet: { width: 768, height: 1024, mobile: false },
  mobile: { width: 375, height: 812, mobile: true },
};

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${ms}ms`), { status: 504 })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function autoScrollForLazyLoad(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = Math.max(200, Math.floor(window.innerHeight * 0.8));
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= scrollHeight || totalHeight > 30000) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          setTimeout(resolve, 150);
        }
      }, 200);
    });
  });
}

async function configurePage(page, { blockAds, removeAds }) {
  if (blockAds || removeAds) {
    await page.setRequestInterception(true);
    page.on('request', async (request) => {
      try {
        const url = request.url();
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          if (await isRequestToBlockedTarget(url)) return request.abort();
        }
        if (blockAds && isAdOrTrackerRequest(url)) return request.abort();
        return request.continue();
      } catch (e) {
        return request.continue();
      }
    });
  }
}

// ============================================================
// Routes
// ============================================================

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'OurTools Screenshot API', version: '4.0.0' });
});

app.get('/health', async (req, res) => {
  let browserConnected = false;
  try {
    if (browserPromise) {
      const b = await browserPromise;
      browserConnected = b.isConnected();
    }
  } catch (e) { /* not connected */ }
  res.json({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    browserConnected,
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
  });
});

// Simple in-memory rate limit: 20 requests/minute/IP on the heavy endpoints.
const screenshotLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a minute and try again.' },
});

app.post('/screenshot', screenshotLimiter, async (req, res) => {
  const {
    url, type = 'fullpage', width, height,
    format = 'jpeg', quality = 85, delay = 1000,
    mobile = false, darkMode = false, scale = 1,
    removeAds = false, selector = null,
    device = null, blockAds = false, lazyLoad = false,
  } = req.body;

  if (!url) return res.status(400).json({ error: 'URL is required' });

  let formattedUrl;
  try {
    formattedUrl = await assertPublicHttpUrl(normalizeUrlInput(url));
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }
  console.log('Screenshot:', formattedUrl);

  const preset = device && DEVICE_PRESETS[device] ? DEVICE_PRESETS[device] : null;
  const finalWidth = parseInt(width) || (preset ? preset.width : 1280);
  const finalHeight = parseInt(height) || (preset ? preset.height : 800);
  const isMobile = mobile === true || mobile === 'true' || (preset ? preset.mobile : false);

  let page;
  try {
    const browser = await withTimeout(getBrowser(), 20000, 'Browser launch');
    page = await browser.newPage();
    await configurePage(page, { blockAds, removeAds });

    await page.setViewport({
      width: finalWidth,
      height: finalHeight,
      deviceScaleFactor: parseInt(scale) || 1,
      isMobile,
    });

    if (isMobile) await page.setUserAgent(MOBILE_UA);
    if (darkMode) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);

    await withTimeout(
      page.goto(formattedUrl, { waitUntil: 'networkidle2', timeout: 30000 }),
      35000,
      'Page navigation'
    );

    if (removeAds) {
      await page.addStyleTag({ content: COOKIE_BANNER_CSS }).catch(() => {});
      await page.evaluate(() => {
        ['[class*="cookie"]', '[id*="cookie"]', '[class*="banner"]', '[class*="popup"]', '[class*="gdpr"]', '[class*="consent"]'].forEach(sel => {
          document.querySelectorAll(sel).forEach(el => {
            if (el.offsetHeight < 300) el.style.display = 'none';
          });
        });
      }).catch(() => {});
    }

    if (lazyLoad) {
      await withTimeout(autoScrollForLazyLoad(page), 20000, 'Lazy-load scroll');
    }

    await new Promise(r => setTimeout(r, Math.min(parseInt(delay) || 1000, 5000)));

    const screenshotOptions = {
      type: format === 'jpg' ? 'jpeg' : (format || 'jpeg'),
      encoding: 'base64',
    };
    if (format !== 'png') screenshotOptions.quality = parseInt(quality) || 85;

    let buffer;
    if (type === 'element' && selector) {
      // Element screenshots are implicitly clipped to the element's own
      // bounds — Puppeteer rejects fullPage/clip alongside an element
      // screenshot ("'clip' and 'fullPage' are mutually exclusive"), so it
      // must not be set here at all (unlike the page-level branch below).
      const el = await page.$(selector);
      if (!el) return res.status(404).json({ error: 'Element not found for the given selector' });
      buffer = await withTimeout(el.screenshot(screenshotOptions), 20000, 'Element screenshot');
    } else {
      buffer = await withTimeout(
        page.screenshot({ ...screenshotOptions, fullPage: type !== 'viewport' }),
        20000,
        'Screenshot capture'
      );
    }

    const pageInfo = await page.evaluate(() => ({
      title: document.title,
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    }));

    console.log('Screenshot success!');
    res.json({
      success: true,
      image: `data:image/${format === 'jpg' ? 'jpeg' : (format || 'jpeg')};base64,${buffer}`,
      format: format || 'jpeg',
      pageInfo,
      url: formattedUrl,
    });

  } catch (error) {
    console.error('Error:', error.message);
    if (looksLikeBrowserNetworkFault(error.message)) await invalidateBrowser(error.message);
    res.status(error.status || 500).json({ error: 'Screenshot failed', details: error.message });
  } finally {
    if (page) await page.close().catch(() => {});
  }
});

app.post('/multi-screenshot', screenshotLimiter, async (req, res) => {
  const { url, blockAds = false, removeAds = false } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  let formattedUrl;
  try {
    formattedUrl = await assertPublicHttpUrl(normalizeUrlInput(url));
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }

  const targets = [
    { name: 'Desktop', width: 1920, height: 1080, mobile: false },
    { name: 'Tablet', width: 768, height: 1024, mobile: false },
    { name: 'Mobile', width: 375, height: 812, mobile: true },
    { name: 'Viewport', width: 1920, height: 1080, mobile: false, viewport: true },
  ];

  const results = [];
  try {
    const browser = await withTimeout(getBrowser(), 20000, 'Browser launch');

    for (const target of targets) {
      let page;
      try {
        page = await browser.newPage();
        await configurePage(page, { blockAds, removeAds });
        await page.setViewport({ width: target.width, height: target.height, isMobile: target.mobile, deviceScaleFactor: target.mobile ? 2 : 1 });
        if (target.mobile) await page.setUserAgent(MOBILE_UA);
        await withTimeout(page.goto(formattedUrl, { waitUntil: 'networkidle2', timeout: 25000 }), 30000, `${target.name} navigation`);
        if (removeAds) await page.addStyleTag({ content: COOKIE_BANNER_CSS }).catch(() => {});
        await new Promise(r => setTimeout(r, 1000));
        const buffer = await withTimeout(
          page.screenshot({ fullPage: !target.viewport, type: 'jpeg', quality: 80, encoding: 'base64' }),
          20000,
          `${target.name} screenshot`
        );
        const dims = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
        results.push({ name: target.name, image: `data:image/jpeg;base64,${buffer}`, width: target.width, height: dims.height });
      } catch (e) {
        results.push({ name: target.name, error: e.message });
        if (looksLikeBrowserNetworkFault(e.message)) {
          await invalidateBrowser(e.message);
          break; // the shared browser is bad; remaining targets would just repeat the same failure
        }
      } finally {
        if (page) await page.close().catch(() => {});
      }
    }

    res.json({ success: true, results, url: formattedUrl });
  } catch (error) {
    if (looksLikeBrowserNetworkFault(error.message)) await invalidateBrowser(error.message);
    res.status(error.status || 500).json({ error: 'Failed', details: error.message });
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
    } catch (e) {
      try {
        execSync('apt-get install -y qpdf 2>/dev/null || true', { stdio: 'ignore', timeout: 30000 });
        execSync('which qpdf', { stdio: 'ignore' });
        qpdfOk = true;
      } catch (e2) {}
    }

    if (qpdfOk) {
      execSync(`qpdf --encrypt "${password}" "${password}" 256 -- "${inputPath}" "${outputPath}"`);
    } else {
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
    try { fs.unlinkSync(inputPath); } catch (e) {}
    try { fs.unlinkSync(outputPath); } catch (e) {}

    res.json({
      success: true,
      pdf: `data:application/pdf;base64,${resultBytes.toString('base64')}`,
      size: resultBytes.length,
      method: qpdfOk ? 'qpdf-aes256' : 'pdf-lib',
    });

  } catch (e) {
    try { fs.unlinkSync(inputPath); } catch (err) {}
    try { fs.unlinkSync(outputPath); } catch (err) {}
    res.status(500).json({ error: 'Failed to lock PDF', details: e.message });
  }
});

// ============================================================
// Process-level safety nets
// ============================================================

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
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
  } catch (e) {}
}, 14 * 60 * 1000); // Every 14 minutes

// Launch the shared browser eagerly at boot so the first real request
// doesn't pay the ~1-3s cold-launch cost.
getBrowser().catch(e => console.error('Initial browser launch failed:', e.message));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
