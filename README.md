# Solar Dashboard

A wall-tablet dashboard for a Sunsynk system. The left half shows live power: solar, battery,
grid and home, with direction of flow, battery level and today's kWh totals. The right half shows
the weather now and for today plus the next three days, with an estimate of each day's solar
production.

It is a web app with no server of its own. The tablet talks directly to the Sunsynk Connect cloud
(`api.sunsynk.net`) and to Open-Meteo for the weather, which needs no API key.

## For the person with the tablet

1. On the Android tablet, open the link in **Chrome**.
2. Tap **⋮ → Install app** (on some phones it says **Add to Home screen**). A **Solar** icon
   appears. Open it from there from now on: it runs full-screen and keeps the screen on.
3. Sign in with the **same email and password as the Sunsynk Connect app**. That's it.

**Tips:**
- **Settings.** Press and hold the ⚙ button (top right) to open settings: sign in again, change
  the weather location, or see diagnostics. A short tap does nothing, so a passer-by can't
  change anything.
- **Charge the tablet** permanently. Turn on **Settings → Display → Stay awake while charging**
  (or similar) as a backup to the app's own keep-awake.
- **If Sunsynk changes your password** (or you do), the dashboard stops and asks you to sign in
  again. It deliberately does not keep retrying, because repeated failed logins can lock the
  account.

**Privacy:** your Sunsynk email and password are kept only in this tablet's browser storage. They
are sent to Sunsynk and nowhere else. Anyone who can unlock the tablet and dig into Chrome's
storage could read them, so use a tablet that lives at home.

## What the screen shows

| Part | Source | How often |
|---|---|---|
| Power flow, battery % | Sunsynk `plant/energy/{id}/flow` | every 2 minutes (the cloud itself updates about every 5) |
| Today's kWh | Sunsynk inverter realtime endpoints | every 6 minutes |
| Weather | Open-Meteo forecast | every 30 minutes |
| Solar estimate | panel size from Sunsynk × forecast radiation × 0.75 | with the weather |

**Status dot:**
- Green: updated within 10 minutes.
- Amber: the data is older than that.
- Red: Sunsynk can't be reached. The last known values stay on screen, dimmed, and it retries
  after 1, 2, then 5 minutes.

## For whoever maintains it

- `index.html`: layout and styles.
- `app.js`: screen logic: polling, rendering, settings, diagnostics.
- `core.js`: everything testable: Sunsynk login crypto (MD5 and RSA PKCS#1 v1.5, since the
  browser has neither built in), API calls, normalising answers, weather, formatting.
- `sw.js`: service worker. It makes the app installable and opens it offline. It never caches
  live data.
- `manifest.webmanifest`, `icons/`: install metadata. `tools/make_icons.py` redraws the icons.
- `version.json`: open tablets check this every 6 hours and when woken, and reload themselves
  when it changes.

**Publishing a change:**
1. Edit the code.
2. Bump `APP_VERSION` in `app.js` **and** `version.json` together. A test fails if they differ.
3. Push.
4. Every installed tablet picks it up within 6 hours, or immediately when its screen is woken.

```bash
node tests/run-all.js
```

**Previewing:** serve the folder with any static server and open `?demo` to see the layout with
made-up data, no account needed. `?debug` opens the diagnostics panel after sign-in.

**The Sunsynk login (as of October 2026):**
1. `GET /anonymous/publicKey?source=sunsynk&nonce=<ms>&sign=md5("nonce=<ms>&source=sunsynkPOWER_VIEW")`
   returns an RSA key.
2. The password is RSA-PKCS#1-v1.5-encrypted with that key.
3. `POST /oauth/token/new` with
   `{client_id:"csp-web", grant_type:"password", username, password, source:"sunsynk", nonce, sign}`,
   where `sign = md5("nonce=<ms>&source=sunsynk" + key.slice(0,10))`.

The API is unofficial and has changed before. If sign-in starts failing with "Invalid login
interface request", the signing scheme has changed again.
