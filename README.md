# Barcelona ⇄ Minsk — Family Road Trip Plan

A small, self-contained static site with the full round-trip family road-trip plan
(Barcelona → Minsk and back), built as three linked HTML pages. No build step, no
dependencies — just open it in a browser.

## Pages

| File | What it is |
| --- | --- |
| [`index.html`](index.html) | Home / hub — pick a direction |
| [`barcelona-minsk-road-trip.html`](barcelona-minsk-road-trip.html) | **Outbound** plan (16–20 Jul): route, tolls, sleep spots, Airbnb villages, checklist, live border news |
| [`minsk-barcelona-return-trip.html`](minsk-barcelona-return-trip.html) | **Return** plan: 15 days in Belarus + two ways home (ferry variant / all-driving variant) |

All three pages are cross-linked — every page has a **🏠 Home** link plus a link to the
other trip, so you can move smoothly between the outbound and return plans.

## Run it locally

Any static file server works. From this folder:

```bash
# Node (already installed)
npx serve .
# → open the printed http://localhost:3000

# or with Python if you have it
python -m http.server 8000
# → open http://localhost:8000
```

You can also just double-click `index.html` to open it directly in a browser.

## Publish on GitHub Pages

The site is already static and lives at the repo root, so publishing is one setting:

1. Push to GitHub (`git push`).
2. On GitHub: **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **Deploy from a branch**.
4. Branch: **`main`**, folder: **`/ (root)`**, then **Save**.
5. After a minute the site is live at:

   **https://teammoleiver.github.io/eu-trip-vl-ss/**

The `.nojekyll` file tells Pages to serve the files as-is (no Jekyll processing).
