# OurTools Screenshot Server

Free website screenshot API for OurTools.in

## Endpoints

- `GET /health` — service status, browser connection, uptime, memory
- `POST /screenshot` — single screenshot
- `POST /multi-screenshot` — desktop/tablet/mobile/viewport set in one call
- `POST /lock-pdf` — unrelated PDF password-locking utility (multipart form: `pdf`, `password`)

### POST /screenshot — body params

| Param | Type | Default | Notes |
|---|---|---|---|
| `url` | string | required | `http(s)://` only; private/internal/localhost targets are rejected |
| `type` | `'fullpage'` \| `'viewport'` \| `'element'` | `'fullpage'` | `'element'` requires `selector` |
| `selector` | string | — | CSS selector, used with `type: 'element'` |
| `device` | `'desktop'` \| `'tablet'` \| `'mobile'` | — | Preset viewport (1920x1080 / 768x1024 / 375x812). Explicit `width`/`height` below still override it |
| `width`, `height` | number | 1280x800 (or device preset) | Custom viewport size |
| `mobile` | boolean | `false` | Emulates a mobile UA + touch; implied by `device: 'mobile'` |
| `scale` | number | 1 | Device pixel ratio |
| `format` | `'png'` \| `'jpeg'` (`'jpg'` accepted) | `'jpeg'` | |
| `quality` | number | 85 | JPEG only, ignored for PNG |
| `darkMode` | boolean | `false` | Emulates `prefers-color-scheme: dark` |
| `delay` | number (ms) | 1000 | Extra wait after network-idle, capped at 5000ms |
| `lazyLoad` | boolean | `false` | Auto-scrolls the page top-to-bottom before capturing, so lazy-loaded images/content have rendered |
| `removeAds` | boolean | `false` | Hides cookie/consent/GDPR banners (CSS injection + DOM cleanup) |
| `blockAds` | boolean | `false` | Blocks known ad/tracker domains at the network level (faster, and they never render at all) |

Response: `{ success, image: "data:image/...;base64,...", format, pageInfo: {title,width,height}, url }`

### POST /multi-screenshot — body params

`url` (required), `removeAds`, `blockAds`. Returns Desktop/Tablet/Mobile/Viewport screenshots in one response.

## Deploy on Render.com

See [RENDER_SETUP.md](RENDER_SETUP.md) for the exact dashboard settings — a `PUPPETEER_CACHE_DIR` environment variable and an explicit browser-install step in the Build Command are both required, not optional, or the service will fail with "Chrome not found" errors.
