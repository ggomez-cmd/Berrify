import { Camera, FileUp, MessageCircle } from "lucide-react";
import { useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../../auth/auth-context";
import { Avatar } from "../../components/ui/avatar";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Select } from "../../components/ui/input";
import { PageTabs } from "../../components/ui/page-tabs";
import { Table, THead, Td, Th } from "../../components/ui/table";
import {
  ACCOUNTS,
  DEFAULT_ACCOUNT_RULES,
  type AccountRule,
  type VendorAlias,
} from "../../lib/invoice-extract";
import { invoicesToPersistFromPhoto } from "../../lib/invoice-pages";
import { extractEngineNote, extractInvoicesAfterOcr } from "../../lib/invoice-extract-api";
import {
  accountsForConnection,
  applyQbAccountNames,
  connectionIdForInvoiceAccounts,
  matchQbApAccount,
} from "../../lib/qb-account-match";
import { connectionIdForInvoiceVendors, matchQbVendor, vendorsForConnection } from "../../lib/qb-vendor-match";
import { EXTRACT_EXAMPLE_LIMIT, pickClosestExamples } from "../../lib/invoice-review-memory";
import { formatMoney } from "../../lib/format";
import { invoiceSourceLabel } from "../../lib/invoice-source";
import { assertInvoiceImage } from "../../lib/invoice-image";
import { getOcrEngine, ocrEngineNote, ocrImage, setOcrEngine, type OcrEngine } from "../../lib/ocr";
import { isManager } from "../../lib/schedule";
import { matchRestaurant } from "../../lib/restaurant-route";
import { invoiceBillJob, invoiceBooksStatus } from "../../lib/qbwc-status";
import type { InvoiceSource, InvoiceWithSupplier } from "../../lib/types";
import {
  useQuickbooksAccounts,
  useQuickbooksConnections,
  useQuickbooksJobs,
  useQuickbooksOnlineConnections,
  useQuickbooksVendors,
} from "../quickbooks/hooks";
import { useSuppliers } from "../suppliers/hooks";
import { InvoiceReviewDialog } from "./InvoiceReviewDialog";
import {
  fileToDataUrl,
  useAccountRules,
  useCreateInvoice,
  useDeleteInvoice,
  useInvoiceExtractExamples,
  useInvoices,
  useRestaurantAliases,
  useRestaurants,
  useSkuAliases,
  useVendorAliases,
} from "./hooks";

function confirmDeleteInvoice(invoice: InvoiceWithSupplier) {
  const vendor = invoice.suppliers?.name ?? invoice.vendor_name;
  const number = invoice.invoice_number;
  const detail = [vendor, number].filter(Boolean).join(" · ");
  return window.confirm(detail ? `Delete this invoice? ${detail}` : "Delete this invoice?");
}

function statusTone(status: InvoiceWithSupplier["status"]) {
  switch (status) {
    case "received":
      return "neutral" as const;
    case "extracted":
      return "warn" as const;
    case "reviewed":
      return "ok" as const;
    case "exported":
      return "info" as const;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

export function InvoicesPage() {
  const { role } = useAuth();
  const { data: invoices = [], isLoading, error, refetch: refetchInvoices } = useInvoices();
  const { data: qbJobs = [], refetch: refetchQbJobs } = useQuickbooksJobs();
  const { data: qbConnections = [] } = useQuickbooksConnections();
  const { data: qbOnlineConnections = [] } = useQuickbooksOnlineConnections();
  const { data: qbVendors = [] } = useQuickbooksVendors();
  const { data: qbAccounts = [] } = useQuickbooksAccounts();
  const { data: suppliers = [] } = useSuppliers();
  const { data: restaurants = [] } = useRestaurants();
  const { data: restaurantAliases = [] } = useRestaurantAliases();
  const { data: aliases = [] } = useVendorAliases();
  const { data: extractExamples = [] } = useInvoiceExtractExamples();
  const { data: skuAliases = [] } = useSkuAliases();
  const { data: rules = [] } = useAccountRules();
  const create = useCreateInvoice();
  const remove = useDeleteInvoice();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<InvoiceWithSupplier | null>(null);
  const [restaurantFilter, setRestaurantFilter] = useState("");
  const [ocrEngine, setOcrEngineState] = useState<OcrEngine>(() => getOcrEngine());
  const [statusTab, setStatusTab] = useState<"all" | InvoiceWithSupplier["status"]>("all");

  if (!isManager(role)) {
    return <Navigate to="/schedule" replace />;
  }

  const ingest = async (file: File, source: InvoiceSource, caption?: string) => {
    setBusy(true);
    setMessage("Reading invoice photo…");
    try {
      assertInvoiceImage(file);
      const { data, mime } = await fileToDataUrl(file);
      setMessage(ocrEngine === "tesseract" ? "Reading with Tesseract…" : "Reading with Vision…");
      const ocr = await ocrImage(data, { engine: ocrEngine });
      const vendorAliases: VendorAlias[] = aliases.map((a) => ({
        match_text: a.match_text,
        supplier_id: a.supplier_id,
        qbo_vendor_name: a.qbo_vendor_name,
      }));
      const accountRules: AccountRule[] =
        rules.length > 0
          ? rules.map((r) => ({
              keyword: r.keyword,
              account: r.account,
              memo: r.memo,
              category: r.category,
            }))
          : DEFAULT_ACCOUNT_RULES;
      const ocrText = ocr.text || caption || "";
      const route = matchRestaurant(
        { ocrText: ocr.text || caption || "", caption },
        restaurants.map((r) => ({
          id: r.id,
          name: r.name,
          qbo_company_name: r.qbo_company_name,
          slug: r.slug,
        })),
        restaurantAliases.map((a) => ({
          restaurant_id: a.restaurant_id,
          match_kind: a.match_kind,
          match_text: a.match_text,
        })),
      );
      const { invoices: extracted, engine: extractEngine, error: extractError } =
        await extractInvoicesAfterOcr({
        ocrText,
        image: data,
        confidence: ocr.confidence,
        restaurants: restaurants.map((r) => ({
          name: r.name,
          qbo_company_name: r.qbo_company_name,
          slug: r.slug,
        })),
        vendorAliases,
        accountRules,
        skuAliases: skuAliases.map((alias) => ({
          match_text: alias.match_text,
          account: alias.account,
          memo: alias.memo,
          category: alias.category,
        })),
        examples: pickClosestExamples(ocrText, extractExamples, EXTRACT_EXAMPLE_LIMIT, {
          aliases: vendorAliases,
          restaurantId: route?.restaurant.id ?? null,
        }),
      });
      const ids: string[] = [];
      for (const bill of invoicesToPersistFromPhoto(extracted)) {
        const restaurantId = route?.restaurant.id ?? null;
        const scopedAccounts = accountsForConnection(
          connectionIdForInvoiceAccounts(restaurantId, qbConnections, qbOnlineConnections),
          qbAccounts,
        );
        const match = matchQbVendor({
          printName: bill.vendor_name,
          ocrText,
          lines: bill.lines,
          vendors: vendorsForConnection(
            connectionIdForInvoiceVendors(restaurantId, qbConnections, qbOnlineConnections),
            qbVendors,
          ),
          aliases: vendorAliases,
        });
        const mixed = match.reason === "mixed" || match.reason === "unclear";
        const id = await create.mutateAsync({
          source,
          image_data: data,
          image_mime: mime,
          ocr_text: ocr.text,
          caption,
          restaurant_id: restaurantId,
          vendor_name: mixed ? null : (match.fullName ?? bill.vendor_name),
          supplier_id: mixed ? null : bill.supplier_id,
          invoice_number: bill.invoice_number,
          invoice_date: bill.invoice_date,
          due_date: bill.due_date,
          terms: bill.terms,
          subtotal: bill.subtotal,
          tax: bill.tax,
          total: bill.total,
          ap_account: matchQbApAccount(scopedAccounts, ACCOUNTS.ap),
          status: bill.lines.length > 0 || bill.total > 0 ? "extracted" : "received",
          lines: bill.lines,
          expenses: applyQbAccountNames(bill.expenses, scopedAccounts),
        });
        ids.push(id);
      }
      const ocrNote = ocr.warning ? `${ocr.warning} · ${ocrEngineNote(ocr)}` : ocrEngineNote(ocr);
      setMessage(
        `${ids.length} digital bill${ids.length === 1 ? "" : "s"} created${route ? ` for ${route.restaurant.qbo_company_name}` : ""}. ${ocrNote} · ${extractEngineNote(extractEngine, extractError)} · review the restaurant and Expenses tab, then export IIF.`,
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not read invoice");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="mb-4 max-w-2xl text-sm text-muted">
        Photograph a supplier invoice or a WhatsApp forward from that restaurant’s group.
        Berrify picks the books from the group name, caption, or sold-to (Semilla vs Kane
        Rum Bar), then rolls SKUs into that restaurant’s QuickBooks Desktop Expenses tab.
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-2 md:flex-nowrap">
        <label className="inline-flex">
          <input
            className="hidden"
            type="file"
            accept="image/*"
            capture="environment"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void ingest(file, "camera");
              e.target.value = "";
            }}
          />
          <Button
            variant="outline"
            disabled={busy}
            onClick={(e) => (e.currentTarget.previousSibling as HTMLInputElement)?.click()}
          >
            <Camera className="size-4" />
            Camera
          </Button>
        </label>
        <label className="inline-flex">
          <input
            className="hidden"
            type="file"
            accept="image/*"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void ingest(file, "upload");
              e.target.value = "";
            }}
          />
          <Button
            variant="outline"
            disabled={busy}
            onClick={(e) => (e.currentTarget.previousSibling as HTMLInputElement)?.click()}
          >
            <FileUp className="size-4" />
            Upload photo
          </Button>
        </label>
        <label className="inline-flex">
          <input
            className="hidden"
            type="file"
            accept="image/*"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void ingest(file, "whatsapp", "Forwarded from WhatsApp kitchen group");
              e.target.value = "";
            }}
          />
          <Button
            variant="outline"
            disabled={busy}
            onClick={(e) => (e.currentTarget.previousSibling as HTMLInputElement)?.click()}
          >
            <MessageCircle className="size-4" />
            WhatsApp
          </Button>
        </label>
        <div className="w-full shrink-0 sm:w-44">
          <Select
            aria-label="OCR engine"
            value={ocrEngine}
            disabled={busy}
            onChange={(e) => {
              const engine = e.target.value === "tesseract" ? "tesseract" : "vision";
              setOcrEngineState(engine);
              setOcrEngine(engine);
            }}
          >
            <option value="vision">Google Vision</option>
            <option value="tesseract">Tesseract</option>
          </Select>
        </div>
        <div className="ml-auto w-full shrink-0 sm:w-56">
          <Select value={restaurantFilter} onChange={(e) => setRestaurantFilter(e.target.value)}>
            <option value="">All restaurants</option>
            {restaurants.map((restaurant) => (
              <option key={restaurant.id} value={restaurant.id}>
                {restaurant.name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="mb-4">
        <PageTabs
          items={[
            { id: "all", label: "All" },
            { id: "extracted", label: "Extracted" },
            { id: "reviewed", label: "Reviewed" },
            { id: "exported", label: "Exported" },
          ]}
          value={statusTab}
          onChange={setStatusTab}
        />
      </div>

      {busy || message ? <p className="mb-3 text-sm text-muted">{message}</p> : null}
      {error ? <p className="text-sm text-danger">{error.message}</p> : null}
      {isLoading ? <p className="text-sm text-muted">Loading invoices…</p> : null}

      {!isLoading ? (
        <Table>
          <THead>
            <tr>
              <Th>Vendor</Th>
              <Th>Invoice number</Th>
              <Th>Date</Th>
              <Th>Restaurant</Th>
              <Th>Total</Th>
              <Th>Status</Th>
              <Th />
            </tr>
          </THead>
          <tbody>
            {invoices.length === 0 ? (
              <tr>
                <Td colSpan={7} className="py-10 text-center text-muted">
                  No invoices yet. Photograph a supplier bill or import a WhatsApp photo.
                </Td>
              </tr>
            ) : (
              invoices
                .filter((invoice) => !restaurantFilter || invoice.restaurant_id === restaurantFilter)
                .filter((invoice) => statusTab === "all" || invoice.status === statusTab)
                .map((invoice) => {
                const qbJob = invoiceBillJob(qbJobs, invoice.id);
                const booksStatus = invoiceBooksStatus(qbJob, invoice.quickbooks_txn_id);
                return (
                <tr key={invoice.id} className="hover:bg-paper">
                  <Td>
                    <div className="flex items-center gap-3">
                      <Avatar name={invoice.suppliers?.name ?? invoice.vendor_name ?? "Vendor"} />
                      <div>
                        <div className="font-medium">
                          {invoice.suppliers?.name ?? invoice.vendor_name ?? "—"}
                        </div>
                        <div className="text-xs text-muted">{invoiceSourceLabel(invoice.source)}</div>
                      </div>
                    </div>
                  </Td>
                  <Td className="font-medium">{invoice.invoice_number ?? invoice.id.slice(0, 8)}</Td>
                  <Td>{invoice.invoice_date ?? "—"}</Td>
                  <Td>{invoice.restaurants?.name ?? "—"}</Td>
                  <Td className="font-semibold">{formatMoney(invoice.total)}</Td>
                  <Td>
                    <div className="flex flex-col gap-1">
                      <Badge tone={statusTone(invoice.status)} dot>
                        {invoice.status}
                      </Badge>
                      {booksStatus ? (
                        <Badge tone={booksStatus.tone} dot>
                          {booksStatus.label}
                        </Badge>
                      ) : null}
                    </div>
                  </Td>
                  <Td>
                    <div className="flex justify-end gap-1">
                      <Button variant="subtle" onClick={() => setReviewing(invoice)}>
                        Review
                      </Button>
                      <Button
                        variant="subtle"
                        disabled={remove.isPending}
                        onClick={() => {
                          if (!confirmDeleteInvoice(invoice)) return;
                          void remove.mutateAsync(invoice.id).then(
                            () => {
                              if (reviewing?.id === invoice.id) setReviewing(null);
                            },
                            (err: unknown) => {
                              setMessage(err instanceof Error ? err.message : "Could not delete invoice");
                            },
                          );
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                  </Td>
                </tr>
                );
              })
            )}
          </tbody>
        </Table>
      ) : null}

      <InvoiceReviewDialog
        open={Boolean(reviewing)}
        onOpenChange={(next) => {
          if (!next) setReviewing(null);
        }}
        invoice={reviewing}
        suppliers={suppliers}
        restaurants={restaurants}
        restaurantAliases={restaurantAliases}
        vendorAliases={aliases}
        skuAliases={skuAliases}
        accountRules={rules}
        extractExamples={extractExamples}
        qbJob={reviewing ? invoiceBillJob(qbJobs, reviewing.id) : null}
        onQbJobChange={() => {
          void refetchQbJobs();
          void refetchInvoices();
        }}
      />
    </div>
  );
}
