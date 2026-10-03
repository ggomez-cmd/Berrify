# QuickBooks Desktop Web Connector

Berrify exposes a SOAP service for Intuit QuickBooks Web Connector (QBWC) at
`https://berrify.app/api/qbwc`. QBWC on Windows **pulls** from Berrify. Berrify
never opens a connection to the accounting PC.

After a restaurant (or the org shared file) is **Connected**, a manager can send
a reviewed invoice as an expense `BillAddRq`. IIF / CSV export on the Invoices
page still works. Berrify does **not** auto-enqueue Bills.

## Windows setup

1. On the QuickBooks PC, open the company `.QBW` as **Admin** (single-user is
   simplest for the first authorize).
2. In Berrify, sign in as a manager and open **QuickBooks**.
3. Choose **Shared company file** or a restaurant card, then **Connect QuickBooks Desktop**.
4. Copy the **one-time password**. Berrify stores only a hash and will not show
   it again (use **Regenerate password** if you lose it).
5. **Download Berrify.qwc**. OwnerID and FileID stay stable for that connection.
6. Open **QuickBooks Web Connector** and **Add an application**. Select `Berrify.qwc`.
7. Authorize the application in QuickBooks when prompted (Yes, always / Admin).
8. In QBWC, paste the one-time password for the Berrify username.
9. Check the Berrify row and click **Update Selected**.
10. In Berrify, the card should move from **Waiting for QuickBooks** to
    **Connected** after the company query succeeds. The first Connected sync
    also queues a `vendor_query` and an `account_query`. Click **Refresh
    vendors** or **Refresh accounts** any time after Connected, then **Update
    Selected** again. Do not treat vendors or accounts as synced until that
    VendorQuery / AccountQuery finishes. Then you may turn on Auto-Run in QBWC
    if you want periodic polls.

Scheduler minutes are included in a new `.qwc` download only after the first
successful company query. Re-download does not change OwnerID or FileID.

## Send a reviewed invoice

1. Open the invoice, confirm restaurant, vendor, and expense lines.
2. **Save review**.
3. Click **Send to QuickBooks**. Berrify queues a `bill_add` job on that
   restaurant’s Connected connector, or the org shared connector if the
   restaurant has none. Semilla invoices are never sent to Kane’s company file.
   A restaurant with QuickBooks Online connected does not queue BillAdd; that
   Send posts to Online instead (`docs/qbo-online.md`).
4. In Web Connector, click **Update Selected** (or wait for Auto-Run).
5. Invoice job status moves Queued → Sending → **Synced** with the QuickBooks
   `TxnID`, or **Failed** with the QuickBooks message. Use **Send to QuickBooks**
   again to retry a failed job.

Berrify matches the letterhead to that company file’s vendor **FullName**
(never Kane’s list for Semilla). Kane pairs that differ only by `(food)` /
`(liquor)` are grouped: all food / kitchen / cleaning SKUs pick `(food)`, all
beverage SKUs pick `(liquor)`. Mixed food + liquor is left unset on Review so
you pick the FullName. If the QB vendor list is empty, `vendor_aliases` is the
fallback. BillAdd / IIF use the exact FullName.

Expense rollup on extract and **Recalc rollup** maps SKU categories onto that
company file’s accounts (never Kane’s list for Semilla): tax → SalesTax /
68200-style, wine / liquor / beer → WinePurchase / beverage COGS, food /
kitchen → food or kitchen expense, cleaning → cleaning/supplies when present.
Review may show `number · name` labels. BillAdd `AccountRef` / `APAccountRef`
use the company file **ListID** when `quickbooks_accounts` has it, otherwise
the stored **FullName** column — never the middle-dot display string. `TermsRef`
is sent only when terms match an exact QuickBooks name (`Net 15`, `Net 30`);
`Net30` / `NET 7 DAYS` are omitted and `DueDate` is kept. BillAdd children
follow the Intuit sequence (`VendorRef`, `APAccountRef`, `TxnDate`,
`DueDate`, `RefNumber`, `TermsRef`, `ExpenseLineAdd`). If nothing matches,
`account_rules` and the current defaults stay. Review remains editable.

One photo is one invoice. Two letterheads in one shot stay on one row — pick
the vendor on Review (photograph separately for two Bills). Extra pages attach
to the same invoice: **Add page** on Review, or a Telegram album
(`media_group_id`) / caption `page 2` / `p. 2` / the same invoice number in a
short window. A clearly different vendor FullName starts a new invoice.

This pass does not create vendors. Missing vendor, account, or terms fails the
job with the QuickBooks status message.

Kane can send once that connector is **Connected**. Semilla can send after its
own connector (or the org shared file) is Connected.

## Check the endpoint

`GET https://berrify.app/api/qbwc` returns a short `Berrify QBWC service` body.
`POST` is SOAP 1.1 (`text/xml`), not JSON.

## Troubleshooting

### Authentication (nvu)

- Username in QBWC must match the Berrify connection username.
- Password must be the one-time value from Connect or Regenerate. Old passwords
  stop working after rotate or revoke.
- The connection must be **active**. Revoke disables the username.

### URL / application

- AppURL must be `https://berrify.app/api/qbwc` (HTTPS).
- Do not point QBWC at `/api/health` or a REST JSON path.
- After a Worker deploy, retry **Update Selected**.

### TLS / certificate

- QBWC requires a trusted public HTTPS certificate. `berrify.app` is the
  production host.
- Local `http://localhost` Web Connector setups are not supported in this
  foundation.

### QuickBooks file

- Leave **company file** empty in Berrify to use the `.QBW` that is already
  open.
- If you set a path, it must be reachable on the Windows machine.

### Status stays Waiting or Error

- Confirm QuickBooks was open and the app authorized.
- Check Berrify **last error** on the card (QB status message).
- `GET` the endpoint from the Windows PC’s browser to confirm TLS and DNS.

## What is not included

- No automatic Bills. A manager must click **Send to QuickBooks**.
- No `VendorAddRq`. Vendor names must already exist in that company file.
- A **Connected** company query is not proof that vendors or accounts synced.
  Treat the vendor list as current only after Web Connector completes a
  `vendor_query`. Treat the account list as current only after Web Connector
  completes an `account_query`.
- A **Connected** company query is not proof that a Bill landed. Treat a Bill
  as posted only after Web Connector completes a `bill_add` job and the invoice
  shows **Synced** with a `TxnID`.
