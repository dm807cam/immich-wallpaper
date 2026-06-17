# Immich Wallpaper

A **macOS** and **Linux** system-tray app that rotates your desktop wallpaper
from a self-hosted [Immich](https://immich.app) server.

- **Three source modes** — Random, Person (face-aware), or Theme (AI/CLIP semantic search)
- **Single image or collage** — justified mosaic with 2×2, 3×2, 1×3, or custom layouts
- **Face-aware cropping** — detected faces stay centred in the frame
- **Timed rotation** — per-minute, hourly, or daily intervals
- **Presets** — save and switch named wallpaper configurations from the tray menu
- **Launch at login** — starts silently in the background

## Requirements

**macOS 13+**
The app is not yet code-signed with an Apple Developer certificate, so macOS
Gatekeeper will block it on first launch. To open it:

1. Mount the DMG and drag the app to Applications as usual.
2. In Terminal, strip the quarantine flag:
   ```
   xattr -cr "/Applications/Immich Wallpaper.app"
   ```
3. Double-click the app — it will open normally from now on.

Alternatively: right-click the app → **Open** → **Open** in the dialog, then go
to **System Settings → Privacy & Security** and click **Open Anyway**.

On first connection macOS will also prompt for **Local Network** access — you
must **Allow** it, otherwise requests to a LAN Immich server fail with
"fetch failed" (System Settings → Privacy & Security → Local Network).

**Linux**
The app runs in the system tray — your desktop environment must support it.
KDE, XFCE, MATE, and Cinnamon work out of the box. GNOME users need the
[AppIndicator extension](https://extensions.gnome.org/extension/615/appindicator-support/).

Wallpaper is applied via whichever backend the
[`wallpaper`](https://github.com/sindresorhus/wallpaper) package finds:
`gsettings` (GNOME/Unity), KDE's `plasma-apply-wallpaperimage`, `xfconf-query`
(XFCE), or `nitrogen`. One of these must be installed on your system.

## Installation

Download the latest release for your platform from the
[Releases](../../releases/latest) page:

| Platform | File |
| --- | --- |
| macOS Apple Silicon | `Immich.Wallpaper-*-arm64.dmg` |
| macOS Intel | `Immich.Wallpaper-*-x64.dmg` |
| Linux (universal) | `Immich.Wallpaper-*.AppImage` |
| Linux Debian/Ubuntu | `Immich.Wallpaper-*.deb` |

## Setup

1. Open the app. A tray icon appears in your menu bar / system tray.
2. Click the icon → **Connection** tab.
3. Enter your Immich server URL (e.g. `http://your-immich:2283`) and an API key
   (Immich → Account Settings → API Keys).
4. Click **Test connection**, then **Save**.
5. Switch to the **Wallpaper** tab and pick a source and rotation interval.
6. Click **Save & apply** — your wallpaper updates immediately.

## API endpoints used

All calls go to `<server>/api/...` with your key in `x-api-key`. Nothing else
is contacted — no telemetry, no third-party services.

### Always required

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/users/me` | Validate the connection |
| `GET` | `/api/assets/{id}/thumbnail?size=preview` | Fetch wallpaper images |
| `POST` | `/api/search/random` | Random source |
| `POST` | `/api/search/smart` | Theme / AI source |
| `POST` | `/api/search/metadata` | Person source |

Only the `search/*` endpoint matching your chosen source mode is called, but
allowing all three is simplest.

### Required only for specific features

| Method | Endpoint | Feature |
| --- | --- | --- |
| `GET` | `/api/people?withHidden=false&size=1000` | Person picker |
| `GET` | `/api/albums` | Album filter |
| `GET` | `/api/tags` | Tag filter |

### Optional — graceful degradation if blocked

| Method | Endpoint | Feature | Fallback |
| --- | --- | --- | --- |
| `GET` | `/api/assets/statistics` | Asset count after test | Count hidden |
| `GET` | `/api/faces?id={id}` | Face-aware cropping | Centre crop |
| `GET` | `/api/assets/{id}` | Collage similarity enrichment | Unenriched collage |

### Granular API key permissions

If you scope the key, grant read access to:
`asset.read`, `asset.view`, `person.read`, `album.read`, `tag.read`, and search
(`/api/search/*`). The app is **read-only** — it never creates, modifies, or
deletes anything in your library.

## Privacy & security

- The API key is stored encrypted via `safeStorage` (macOS Keychain / Linux
  secret service) and is never exposed to the renderer process.
- On Linux without a secret service, the key is base64-encoded (not plaintext)
  with a distinguishing prefix — not cryptographically secret, so use `https://`
  if your server is reachable beyond your LAN.
- Use `https://` whenever your Immich server is accessible over the internet —
  plain `http://` sends the API key in cleartext.

## Development

```bash
npm install
npm run dev      # start with hot-reload
npm run build    # typecheck + bundle
npm run dist     # package for the current platform
                 #   macOS → .dmg   Linux → .AppImage + .deb
```
