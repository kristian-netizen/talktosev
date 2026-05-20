# Talk To Sev

Marketing & Claude advisory site for service businesses. Static HTML/CSS, no build step.

## Pages

- `index.html` — homepage with a 2-question quiz that routes visitors to Marketing or Claude With Me
- `claude.html` — Claude With Me, the $385 1:1 hour (buy page)
- `learning.html` — Learning Hub (video grid, placeholder content for now)

The Marketing workshop has no on-site page; every "Marketing" link points to `https://enquire.talktosev.com/apply`.

## How to make it live

It's a plain static site, so any host works. Easiest options:

**Vercel (recommended — `vercel.json` is already set up for clean URLs):**
1. Go to vercel.com → New Project
2. Either drag-and-drop this whole folder, or connect the GitHub repo (`sevspics/talktosev`) and import it
3. No build command, no framework preset needed — it's static. Deploy.
4. Point the `talktosev.com` domain at the project in Vercel → Settings → Domains

**Or any static host** (Netlify, Cloudflare Pages, GitHub Pages, plain web server): just upload the contents of this folder. `index.html` is the entry point.

To preview locally before deploying, open `index.html` in a browser, or run `python3 -m http.server` in this folder and visit `http://localhost:8000`.

## Before launch — 2 things to finish

1. **Stripe link for Claude With Me.** In `claude.html`, the two "Pay & book" buttons point at a placeholder `#stripe`. Create a Stripe Payment Link ($385) and paste its URL into both (search the file for `#stripe` / `TODO`). Configure the receipt + booking-link email inside Stripe — no code needed.
2. **Learning Hub videos.** The 9 cards in `learning.html` are placeholders. Swap in real YouTube thumbnails/embeds and article links when ready.

Nice-to-have later: analytics or a heatmap (e.g. Microsoft Clarity) to see how the homepage quiz performs.

## Structure

```
index.html          homepage + quiz
claude.html         Claude With Me buy page
learning.html       Learning Hub
vercel.json         clean-URL config for Vercel
assets/css/styles.css   the whole design system
assets/img/         Sev portrait + worked-with logos
favicon.svg, favicon-32.png, apple-touch-icon.png, og-image.png
```
