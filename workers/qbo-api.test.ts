import { describe, expect, it } from "vitest";
import {
  buildAuthorizeUrl,
  buildQboBillBody,
  findSyncedVendorId,
  intuitFaultMessage,
  intuitNotConfiguredMessage,
  intuitQueryLiteral,
  mapQueryAccounts,
  mapQueryVendors,
  missingIntuitSecrets,
  parseQboBill,
  qboApiBase,
  qboRedirectUri,
} from "./qbo-api";

describe("QuickBooks Online API helpers", () => {
  it("builds the authorize URL without the client secret", () => {
    const url = buildAuthorizeUrl({
      clientId: "test-client-id",
      redirectUri: "https://berrify.app/api/qbo/callback",
      state: "state-1",
    });
    expect(url).toContain("client_id=test-client-id");
    expect(url).toContain("scope=com.intuit.quickbooks.accounting");
    expect(url).toContain("redirect_uri=https%3A%2F%2Fberrify.app%2Fapi%2Fqbo%2Fcallback");
    expect(url).not.toContain("secret");
  });

  it("names the missing Worker secrets and the redirect URL", () => {
    expect(missingIntuitSecrets({})).toEqual(["INTUIT_CLIENT_ID", "INTUIT_CLIENT_SECRET"]);
    expect(intuitNotConfiguredMessage(qboRedirectUri("https://berrify.app"))).toContain(
      "https://berrify.app/api/qbo/callback",
    );
    expect(qboApiBase(undefined)).toBe("https://quickbooks.api.intuit.com");
    expect(qboApiBase("sandbox")).toBe("https://sandbox-quickbooks.api.intuit.com");
  });

  it("builds a bill with VendorRef and AccountRef ids", () => {
    expect(
      buildQboBillBody({
        vendorId: "56",
        txnDate: "2026-08-12",
        dueDate: "2026-08-27",
        docNumber: "6512495",
        apAccountId: "33",
        lines: [{ amount: 10.125, accountId: "7", description: "Food" }],
      }),
    ).toEqual({
      VendorRef: { value: "56" },
      APAccountRef: { value: "33" },
      TxnDate: "2026-08-12",
      DueDate: "2026-08-27",
      DocNumber: "6512495",
      Line: [
        {
          DetailType: "AccountBasedExpenseLineDetail",
          Amount: 10.13,
          Description: "Food",
          AccountBasedExpenseLineDetail: { AccountRef: { value: "7" } },
        },
      ],
    });
  });

  it("reads Intuit fault text and bill ids", () => {
    expect(
      intuitFaultMessage({
        Fault: { Error: [{ Message: "Invalid Reference Id", Detail: "Vendor assigned to this transaction has been deleted." }] },
      }),
    ).toBe("Invalid Reference Id — Vendor assigned to this transaction has been deleted.");
    expect(parseQboBill({ Bill: { Id: "991", SyncToken: "0" } })).toEqual({ id: "991", syncToken: "0" });
    expect(intuitQueryLiteral("O'Brien")).toBe("'O\\'Brien'");
  });

  it("maps vendors and accounts from a query page", () => {
    expect(
      mapQueryVendors({
        QueryResponse: { Vendor: [{ Id: "56", DisplayName: "Local Farm", CompanyName: "Local Farm LLC", Active: true }] },
      }),
    ).toEqual([{ listId: "56", fullName: "Local Farm", companyName: "Local Farm LLC", isActive: true }]);
    expect(
      mapQueryAccounts({
        QueryResponse: {
          Account: [{ Id: "7", Name: "Food", FullyQualifiedName: "Food Purchases", AcctNum: "50000", AccountType: "Expense" }],
        },
      }),
    ).toEqual([
      { listId: "7", fullName: "Food Purchases", accountNumber: "50000", accountType: "Expense", isActive: true },
    ]);
    expect(findSyncedVendorId("local farm", [{ list_id: "56", full_name: "Local Farm", is_active: true }])).toBe("56");
  });
});
