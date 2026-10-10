# Open Form landing page

This static landing page follows the Open Form Wonder canvas, including Outfit body text, Urbanist headings, the transparent hero illustration, and the blue palette.

## Build

Run `npm ci`, then `npm run build` in this directory. The deployable static website is in `dist/`; it is also committed so a build is optional.

## Cloudflare Worker

Create a separate static-assets Worker for this landing page. From this directory use the included `wrangler.jsonc`, with assets directory `./dist`. No D1 database, Resend key, or other secrets are required by this landing page. Keep the form backend's root Wrangler configuration separate.

The example contact form is a visual illustration, not a submission endpoint. Navigation points to the product's GitHub documentation and security policy.

## Verification

Checked in a local Chromium browser at 1440px desktop, 768px tablet, and 390px mobile widths. Desktop page height: 3343px, matching the source canvas. No horizontal overflow or browser JavaScript errors were observed.

Design source: https://app.wonder.so/awais/files/01a126e1-00ba-7c0d-8f30-149edf146757/branches/main/pages/01a126e1-00bc-7d26-b3ca-28bb08afa91b

Fonts are self-hosted under the SIL Open Font License; license copies are in assets.
