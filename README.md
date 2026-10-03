# Berrify

AI-powered restaurant ERP. This repository ships **Inventory**, **Employee
scheduling**, **Time Clock**, and **supplier invoice capture**: a multi-tenant
workspace for items, stock, a weekly schedule board, punches, and QuickBooks
Desktop bills from sideways invoice photos, backed by Supabase (Postgres + Auth
+ RLS).

How to use every screen: **[User guide](docs/USER_GUIDE.md)** · **[PDF with screenshots](docs/berrify-user-guide.pdf)**.

**Production:** [https://berrify.app](https://berrify.app) (also [www.berrify.app](https://www.berrify.app) and [berrify.ggomez-fd2.workers.dev](https://berrify.ggomez-fd2.workers.dev)). Sign in with `demo@berrify.local` / `12345678` (manager) or `server@berrify.local` / `12345678` (staff). Add each origin under Supabase Auth → URL configuration → Redirect URLs, including `https://berrify.app/reset-password` and local `http://localhost:5173/reset-password`.

## Stack

- React 18 + TypeScript + Vite
- Tailwind CSS v4
- React Router, TanStack Query
- Supabase (`@supabase/supabase-js`)
- Node scripts (`tsx` + `pg`) for migrations and seed

## Prerequisites

- Node.js 20+ (developed against Node 22)
- A Supabase project (URL, anon key, service role, and a Postgres connection string)

## Local setup

```bash
git clone https://github.com/ggomez-cmd/Berrify.git
cd Berrify
cp .env.example .env
# fill NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
# SUPABASE_SERVICE_ROLE_KEY, and DIRECT_URL
npm install
npm run db:push
npm run db:seed
npm run dev
```

The dev server runs at http://localhost:5173.

Demo accounts (created by `npm run db:seed`), password `12345678`:

- Manager: `demo@berrify.local`
- Staff (server): `server@berrify.local`
- Staff (cook): `cook@berrify.local`

Admins create employee accounts on the Employees page. The login screen is
sign-in only (no sign up). Use **Forgot password?** to email a reset link.

The reset message is the Berrify-branded HTML in
`supabase/templates/recovery.html` (subject **Reset your Berrify password**).
Paste it into Supabase **Authentication → Email Templates → Reset password**,
or apply it with `SUPABASE_ACCESS_TOKEN` and `npm run auth:email-templates`.
The wordmark is served from `https://berrify.app/email/berrify-wordmark.png`.

## Scripts

| Command             | Description                                         |
| ------------------- | --------------------------------------------------- |
| `npm run dev`       | Start the Vite dev server.                          |
| `npm run build`     | Type-check and build for production.                |
| `npm run preview`   | Preview the production build.                       |
| `npm run lint`      | Run ESLint.                                         |
| `npm run typecheck` | Type-check without emitting.                        |
| `npm test`          | Run Vitest unit tests.                              |
| `npm run db:push`   | Apply `supabase/migrations/*.sql` via `DIRECT_URL`. |
| `npm run verify:db` | Assert tables, RLS, and policies exist.             |
| `npm run db:seed`   | Create demo users, inventory, roster, shifts, and a Jose Santiago bill. |
| `npm run db:fill`   | Fill empty screens (this week’s board, punches, invoice statuses). |
| `npm run workers:dev` | Build the app and run it on Cloudflare Workers locally. |
| `npm run workers:deploy` | Build and deploy the Worker (SPA + `/api`). |
| `npm run whatsapp:ingest` | File + caption → same invoice pipeline (Business inbox). |
| `npm run auth:email-templates` | Push the branded reset-password email to Supabase Auth. |

## Data model

Multi-tenant by organization. Inventory and scheduling rows are scoped by
`org_id`. Row Level Security allows access only when the signed-in user has a
`memberships` row for that org.

- Low stock is `quantity <= reorder_level`. Adjusting stock writes a
  `stock_movements` row; a database trigger updates `inventory_items.quantity`.
- Shifts may be `draft` or `published`. Staff can only read published shifts.
  Admins and managers can edit the week board. Only admins can create accounts
  and set pay. Staff cannot read inventory or invoices.
- `employees.user_id` is optional. Roster rows can exist before the person has
  a login.
- Invoices store raw SKU lines plus rolled-up `invoice_expense_lines` (Food,
  Kitchen, Cleaning, Tax). Export is a QuickBooks Desktop IIF Bill on the
  Expenses tab (A/P `20000`), not one item line per SKU.

## Invoices → QuickBooks Desktop Bill

1. Photograph a supplier invoice — Jose Santiago, Ballester Hermanos, SuperMax,
   Drouyn, Santurce Brewing, B. Fernández, Northwestern Selecta, or a clipped
   pair (often rotated 90°) — or import a WhatsApp forward.
2. Open **Invoices**, review the photo, SKUs (bill qty = **Desp** on Jose
   Santiago), and the proposed Expenses tab. One photo can create two bills.
3. Export **Desktop IIF** (or CSV fallback) and import the Bill in QuickBooks
   Desktop. Vendors and terms: Jose Santiago Inc (Net 15), Ballester Hermanos
   Inc (Net 30), SuperMax (due on receipt), Drouyn & Co (Net 7), Santurce
   Brewing Inc (Net 15), B. Fernandez & Hnos Inc (Net 30), Northwestern Selecta
   (Net 7). Expenses tab only — food, beverage, kitchen, cleaning, tax.

The seed includes the Jose Santiago `$1,155.59` example (ref `6512495`) with
expense splits `$32.95` tax / `$176.55` kitchen / `$30.34` Fabuloso /
`$915.75` food. Other fixtures: Ballester `$757.56` food, SuperMax `$48.44`,
Drouyn `$61.50`, Santurce `$78.05` (beer + tax), Fernández `$182.86` (rum +
tax), Northwestern `$446.27`.

Each restaurant has its own QuickBooks company file. Official WhatsApp Cloud
API cannot join a normal kitchen group, so staff photograph the bill in that
restaurant’s group and forward it (or upload it). Routing order:

1. `--group "Kane invoices"` / `--restaurant kane-rum-bar`
2. `--from` Business number mapped in `restaurant_aliases`
3. Caption (`semilla`, `kane`)
4. Sold-to / ship-to on the factura (Semilla · 57 Delcasse vs Kane Rum Bar · Ashford)

Do not use `CAN ENTERPRISE` alone — both restaurants print that. Seed restaurants
are **Semilla** and **Kane Rum Bar**.

```bash
npm run whatsapp:ingest -- --file ./factura.jpg --group "Kane invoices"
npm run whatsapp:ingest -- --file ./ocr.txt --caption "Semilla factura"
```

The webhook JSON shape is documented at the top of
`scripts/whatsapp-ingest.ts`. Posting Bills through QuickBooks Web Connector,
QBO Online OAuth, and unofficial group bots are out of scope. SOAP connector
foundation (company query only) is documented in [docs/qbwc-desktop.md](docs/qbwc-desktop.md).
Invoices **Camera/Upload** and
**Review** call `POST /api/ocr` first (Cloud Vision Document Text Detection,
Spanish + English). After OCR, Camera / Upload / Review call
`POST /api/invoice-extract` (Gemini Flash, `GEMINI_API_KEY` on the Worker).
If that secret is missing (503) or extract fails, the client uses the current
`extractInvoicesFromText` rules. If Vision is missing or fails, the browser
falls back to `tesseract.js` `eng` at 0/90/180/270 and keeps the highest
confidence. `whatsapp:ingest` still OCRs image files with Tesseract only.
Telegram and WhatsApp webhooks insert `ocr_text: null` and do **not** call
Gemini. Pink carbonless photos that were shot sideways usually need a human
pass in Review before you export.

## Cloudflare Workers

The production app is a Vite SPA plus a small Worker. Static files come from
`dist/`. Unmatched routes serve `index.html` so React Router deep links work.
`/api/*` hits the Worker first:

- `GET /api/health` — liveness JSON
- `POST /api/ocr` — session-authenticated Cloud Vision Document Text Detection (`GOOGLE_VISION_API_KEY`); 503 when the secret is missing so the browser falls back to Tesseract
- `POST /api/invoice-extract` — session-authenticated Gemini Flash extract (`GEMINI_API_KEY`); 503 when the secret is missing so the browser falls back to `extractInvoicesFromText`
- `GET /api/webhooks/whatsapp` — Meta verify-token handshake (`WHATSAPP_VERIFY_TOKEN`)
- `POST /api/webhooks/whatsapp` — Cloud API ingest (HMAC + Graph media download → `invoices` row, no OCR on the Worker)
- `POST /api/webhooks/telegram` — Bot API ingest (`X-Telegram-Bot-Api-Secret-Token` + `getFile` download → `invoices` row, no OCR on the Worker)

```bash
cp .dev.vars.example .dev.vars
npm run workers:dev
```

That builds the client, then serves it at http://127.0.0.1:8787. Deploy:

```bash
npx wrangler login
npm run workers:deploy
```

The Worker also stays on `https://berrify.ggomez-fd2.workers.dev`. Custom
domains `berrify.app` and `www.berrify.app` are declared in `wrangler.jsonc`.
Add those origins under Supabase Auth → URL configuration → Redirect URLs,
plus `https://berrify.app/reset-password` and `http://localhost:5173/reset-password`.

GitHub Actions (`.github/workflows/deploy-workers.yml`) deploys on push to
`main` when these repository secrets exist:

- `CLOUDFLARE_API_TOKEN` — token with Edit Cloudflare Workers
- `CLOUDFLARE_ACCOUNT_ID`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

Worker secrets for inbound WhatsApp, Telegram, Vision OCR, and Gemini extract (also listed in `.dev.vars.example`):

```bash
npx wrangler secret put WHATSAPP_VERIFY_TOKEN
npx wrangler secret put WHATSAPP_APP_SECRET
npx wrangler secret put WHATSAPP_ACCESS_TOKEN
npx wrangler secret put WHATSAPP_PHONE_NUMBER_ID
npx wrangler secret put WHATSAPP_ORG_ID
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put TELEGRAM_ORG_ID
npx wrangler secret put NEXT_PUBLIC_SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put GOOGLE_VISION_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put INTUIT_CLIENT_ID
npx wrangler secret put INTUIT_CLIENT_SECRET
```

QuickBooks Online also needs those two Intuit secrets and redirect URL
`https://berrify.app/api/qbo/callback`. See `docs/qbo-online.md`. Apply
`0026_quickbooks_online.sql` with `npm run db:apply` (not `db:push`).

Set the same `GEMINI_API_KEY` in the Cloudflare dashboard (Workers → Settings → Variables and Secrets) as you do for Vision. Use a **billed** Gemini API key from Google AI Studio / Gemini API. Do not turn on Google’s “used to improve products” / training-data sharing for that key. Never put `GEMINI_API_KEY` in Vite/`NEXT_PUBLIC_*` or the browser.

Saving Invoice Review upserts `vendor_aliases` when a supplier is set and writes `invoice_sku_aliases` from corrected SKU/expense lines so later extracts can reuse them. Apply `0015_invoice_sku_aliases.sql` with `npm run db:apply -- 0015_invoice_sku_aliases.sql` (do not `db:push`).

[Cloud Vision pricing](https://cloud.google.com/vision/pricing): the first 1,000 images/month are free; after that Document Text Detection is about $1.50 / 1,000. Without `GOOGLE_VISION_API_KEY`, `POST /api/ocr` returns 503 and the SPA uses Tesseract.

`POST /api/webhooks/whatsapp` verifies `X-Hub-Signature-256`, downloads image media from Graph, and inserts `source: "whatsapp"` / `status: "received"` with `ocr_text` left null. Duplicate `whatsapp_message_id` values return 200. OCR runs later in Invoices → Review. The official Cloud API cannot join a kitchen group — staff photograph the bill there, then forward it to the Business number with a `Semilla` or `Kane` caption.

`POST /api/webhooks/telegram` verifies `X-Telegram-Bot-Api-Secret-Token`, downloads `message.photo` or an image `message.document` via Bot API `getFile` (same 8 MB cap), and inserts `source: "telegram"` / `status: "received"` with `ocr_text` left null. Duplicate `telegram_message_id` values (`chat_id:message_id`) return 200. getFile/insert failures are logged and returned in the JSON `errors` array; if every item fails the Worker responds 502. Point `setWebhook` at `https://<host>/api/webhooks/telegram` with the same `secret_token`. Caption words such as `Semilla` or `Kane` still route the bill. WhatsApp ingest is unchanged.

Apply the Telegram columns once with `npm run db:apply -- 0014_telegram_invoice_ingest.sql` (do not `db:push`).

Cursor loads Cloudflare MCP servers from `.cursor/mcp.json` (docs, bindings,
builds, observability, and the main API). Authenticate the account-scoped
servers in Cursor Settings → MCP. Cloudflare agent skills:

```bash
npx -y skills add cloudflare/skills --skill '*' --yes --global
```

## Cursor Cloud Agent environment

`.cursor/environment.json` installs dependencies with `npm ci` and runs
`npm run dev` on port `5173`. Migrations are **not** run on agent boot.

## License

MIT
