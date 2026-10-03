import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AuthContext, type AuthState } from "../../auth/auth-context";
import type { Organization } from "../../lib/types";
import { QuickbooksPage } from "./QuickbooksPage";

const org: Organization = {
  id: "org-1",
  name: "Pacifico Kitchen",
  created_at: "2026-01-01T00:00:00.000Z",
  timezone: "America/Puerto_Rico",
  workweek_start_dow: 0,
  workweek_start_time: "00:00",
  default_meal_break_paid: false,
  default_rest_break_paid: true,
};

const auth: AuthState = {
  session: { access_token: "test" } as AuthState["session"],
  user: { id: "user-1", email: "demo@berrify.local" } as AuthState["user"],
  org,
  role: "admin",
  loading: false,
  recovery: false,
  signOut: async () => undefined,
};

vi.mock("../invoices/hooks", () => ({
  useRestaurants: () => ({
    data: [{ id: "r-1", name: "Semilla", qbo_company_name: "Semilla", slug: "semilla" }],
  }),
}));

vi.mock("./hooks", () => ({
  useQuickbooksConnections: () => ({
    data: [
      {
        id: "c-shared",
        org_id: "org-1",
        restaurant_id: null,
        name: "Shared company file",
        qb_username: "bfy_shared",
        owner_id: "11111111-1111-4111-8111-111111111111",
        file_id: "22222222-2222-4222-8222-222222222222",
        company_file: null,
        qb_company_name: null,
        qb_product_name: null,
        qb_major_version: null,
        qb_minor_version: null,
        is_active: true,
        last_connected_at: null,
        last_successful_sync_at: null,
        last_error: null,
        created_at: "2026-09-19T00:00:00.000Z",
        updated_at: "2026-09-19T00:00:00.000Z",
      },
    ],
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useQuickbooksJobs: () => ({ data: [], refetch: vi.fn() }),
  useQuickbooksVendors: () => ({ data: [], refetch: vi.fn() }),
  useQuickbooksAccounts: () => ({ data: [], refetch: vi.fn() }),
  useQuickbooksOnlineConnections: () => ({ data: [], refetch: vi.fn() }),
  useQuickbooksOnlineConfig: () => ({
    data: {
      configured: false,
      redirect_uri: "https://berrify.app/api/qbo/callback",
      missing: ["INTUIT_CLIENT_ID", "INTUIT_CLIENT_SECRET"],
    },
  }),
}));

function renderPage(role: AuthState["role"] = "admin") {
  return render(
    <AuthContext.Provider value={{ ...auth, role }}>
      <MemoryRouter initialEntries={["/quickbooks"]}>
        <Routes>
          <Route path="/quickbooks" element={<QuickbooksPage />} />
          <Route path="/schedule" element={<div>Schedule content</div>} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe("QuickbooksPage", () => {
  it("shows connect and download actions for managers", () => {
    renderPage("manager");
    expect(screen.getByText("Shared company file")).toBeInTheDocument();
    expect(screen.getByText("Waiting for QuickBooks")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download Berrify.qwc" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh vendors" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh accounts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Regenerate password" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect QuickBooks Desktop" })).toBeInTheDocument();
    expect(screen.getByText("Online not connected")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Connect QuickBooks Online" })).toHaveLength(1);
    expect(screen.getByText(/INTUIT_CLIENT_ID and INTUIT_CLIENT_SECRET/)).toBeInTheDocument();
    expect(screen.getByText(/https:\/\/berrify.app\/api\/qbo\/callback/)).toBeInTheDocument();
    expect(screen.queryByText(/service-role/i)).toBeNull();
  });

  it("sends staff to the schedule", () => {
    renderPage("staff");
    expect(screen.getByText("Schedule content")).toBeInTheDocument();
  });
});
