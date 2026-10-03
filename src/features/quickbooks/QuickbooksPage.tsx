import { Download, KeyRound, Plug, RefreshCw, ShieldOff } from "lucide-react";
import { useMemo, useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth/auth-context";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import {
  disconnectQbo,
  refreshQboAccounts,
  refreshQboVendors,
  startQboConnect,
} from "../../lib/qbo-manager-api";
import {
  createQbwcConnection,
  downloadBerrifyQwc,
  refreshQbwcAccounts,
  refreshQbwcVendors,
  revokeQbwcConnection,
  rotateQbwcPassword,
} from "../../lib/qbwc-manager-api";
import { accountSyncSummary, qbwcStatusLabel, qbwcUiStatus, vendorSyncSummary } from "../../lib/qbwc-status";
import { isManager } from "../../lib/schedule";
import type {
  QbwcUiStatus,
  QuickbooksDesktopConnection,
  QuickbooksOnlineConnection,
  Restaurant,
} from "../../lib/types";
import { useRestaurants } from "../invoices/hooks";
import {
  useQuickbooksAccounts,
  useQuickbooksConnections,
  useQuickbooksJobs,
  useQuickbooksOnlineConfig,
  useQuickbooksOnlineConnections,
  useQuickbooksVendors,
} from "./hooks";

function statusTone(status: QbwcUiStatus) {
  switch (status) {
    case "not_configured":
      return "neutral" as const;
    case "waiting":
      return "warn" as const;
    case "connected":
      return "ok" as const;
    case "syncing":
      return "info" as const;
    case "error":
      return "danger" as const;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

type CardTarget = {
  key: string;
  title: string;
  subtitle: string;
  restaurantId: string | null;
};

export function QuickbooksPage() {
  const { role } = useAuth();
  const [searchParams] = useSearchParams();
  const { data: restaurants = [] } = useRestaurants();
  const { data: connections = [], isLoading, error, refetch } = useQuickbooksConnections();
  const { data: onlineConnections = [], refetch: refetchOnline } = useQuickbooksOnlineConnections();
  const { data: qboConfig } = useQuickbooksOnlineConfig();
  const { data: jobs = [], refetch: refetchJobs } = useQuickbooksJobs();
  const { data: vendors = [], refetch: refetchVendors } = useQuickbooksVendors();
  const { data: accounts = [], refetch: refetchAccounts } = useQuickbooksAccounts();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [oneTime, setOneTime] = useState<{ connectionId: string; username: string; password: string } | null>(
    null,
  );
  const [message, setMessage] = useState<string | null>(null);

  const targets: CardTarget[] = useMemo(() => {
    const shared: CardTarget = {
      key: "shared",
      title: "Shared company file",
      subtitle: "One QuickBooks company file for the whole organization",
      restaurantId: null,
    };
    const perRestaurant = restaurants.map((restaurant: Restaurant) => ({
      key: restaurant.id,
      title: restaurant.name,
      subtitle: restaurant.qbo_company_name,
      restaurantId: restaurant.id,
    }));
    return [shared, ...perRestaurant];
  }, [restaurants]);

  if (!isManager(role)) {
    return <Navigate to="/schedule" replace />;
  }

  const connectionFor = (restaurantId: string | null) =>
    connections.find((row) => (row.restaurant_id ?? null) === restaurantId) ?? null;

  const refresh = async () => {
    await Promise.all([refetch(), refetchOnline(), refetchJobs(), refetchVendors(), refetchAccounts()]);
  };

  const onlineFor = (restaurantId: string | null) =>
    restaurantId
      ? (onlineConnections.find((row) => row.restaurant_id === restaurantId && row.is_active) ?? null)
      : null;

  const connect = async (target: CardTarget) => {
    setBusyKey(target.key);
    setMessage(null);
    try {
      const result = await createQbwcConnection({
        restaurant_id: target.restaurantId,
        name: target.title,
      });
      setOneTime({
        connectionId: result.connection.id,
        username: result.connection.qb_username,
        password: result.password,
      });
      await refresh();
      setMessage("Connection created. Copy the password now — Berrify will not show it again.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not create connection");
    } finally {
      setBusyKey(null);
    }
  };

  const rotate = async (connection: QuickbooksDesktopConnection) => {
    setBusyKey(connection.id);
    setMessage(null);
    try {
      const password = await rotateQbwcPassword(connection.id);
      setOneTime({ connectionId: connection.id, username: connection.qb_username, password });
      await refresh();
      setMessage("Password regenerated. Update it in QuickBooks Web Connector.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not regenerate password");
    } finally {
      setBusyKey(null);
    }
  };

  const revoke = async (connection: QuickbooksDesktopConnection) => {
    setBusyKey(connection.id);
    setMessage(null);
    try {
      await revokeQbwcConnection(connection.id);
      if (oneTime?.connectionId === connection.id) setOneTime(null);
      await refresh();
      setMessage("Web Connector access revoked.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not revoke connection");
    } finally {
      setBusyKey(null);
    }
  };

  const refreshVendors = async (connection: QuickbooksDesktopConnection) => {
    setBusyKey(connection.id);
    setMessage(null);
    try {
      await refreshQbwcVendors(connection.id);
      await refresh();
      setMessage("Vendor query queued. In Web Connector, click Update Selected. Vendors are not synced until that VendorQuery completes.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not refresh vendors");
    } finally {
      setBusyKey(null);
    }
  };

  const refreshAccounts = async (connection: QuickbooksDesktopConnection) => {
    setBusyKey(connection.id);
    setMessage(null);
    try {
      await refreshQbwcAccounts(connection.id);
      await refresh();
      setMessage(
        "Account query queued. In Web Connector, click Update Selected. Accounts are not synced until that AccountQuery completes.",
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not refresh accounts");
    } finally {
      setBusyKey(null);
    }
  };

  const connectOnline = async (restaurantId: string) => {
    setBusyKey(`qbo:${restaurantId}`);
    setMessage(null);
    try {
      const result = await startQboConnect(restaurantId);
      window.location.assign(result.url);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not connect QuickBooks Online");
      setBusyKey(null);
    }
  };

  const refreshOnlineVendors = async (connection: QuickbooksOnlineConnection) => {
    setBusyKey(connection.id);
    setMessage(null);
    try {
      await refreshQboVendors(connection.id);
      await refresh();
      setMessage("Vendors synced from QuickBooks Online for this company.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not refresh QuickBooks Online vendors");
    } finally {
      setBusyKey(null);
    }
  };

  const refreshOnlineAccounts = async (connection: QuickbooksOnlineConnection) => {
    setBusyKey(connection.id);
    setMessage(null);
    try {
      await refreshQboAccounts(connection.id);
      await refresh();
      setMessage("Accounts synced from QuickBooks Online for this company.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not refresh QuickBooks Online accounts");
    } finally {
      setBusyKey(null);
    }
  };

  const disconnectOnline = async (connection: QuickbooksOnlineConnection) => {
    if (!window.confirm(`Disconnect QuickBooks Online for ${connection.company_name || "this restaurant"}?`)) return;
    setBusyKey(connection.id);
    setMessage(null);
    try {
      await disconnectQbo(connection.id);
      await refresh();
      setMessage("QuickBooks Online disconnected for this restaurant.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not disconnect QuickBooks Online");
    } finally {
      setBusyKey(null);
    }
  };

  const download = async (connection: QuickbooksDesktopConnection) => {
    setBusyKey(connection.id);
    setMessage(null);
    try {
      await downloadBerrifyQwc(connection.id);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not download Berrify.qwc");
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-muted">
        QuickBooks Desktop uses Web Connector. QuickBooks Online is a separate connect on a restaurant card.
        This page does not post Bills. A manager sends one invoice at a time. Invoice IIF export is unchanged.
        Windows Web Connector steps are in <span className="font-mono">docs/qbwc-desktop.md</span>. Online
        setup is in <span className="font-mono">docs/qbo-online.md</span>.
      </p>

      {searchParams.get("qbo") === "connected" ? (
        <p className="text-sm text-ink">
          QuickBooks Online connected.
          {searchParams.get("message") ? ` ${searchParams.get("message")}` : " Vendors and accounts were synced for that company."}
        </p>
      ) : null}
      {searchParams.get("qbo") === "denied" ? (
        <p className="text-sm text-ink">QuickBooks Online connect was cancelled.</p>
      ) : null}
      {searchParams.get("qbo") === "error" ? (
        <p className="text-sm text-danger">{searchParams.get("message") || "QuickBooks Online connect failed."}</p>
      ) : null}

      {oneTime ? (
        <Card className="border-wine/30 bg-wine/5">
          <p className="text-sm font-semibold text-ink">One-time Web Connector password</p>
          <p className="mt-1 text-sm text-muted">
            Username <span className="font-mono text-ink">{oneTime.username}</span>
          </p>
          <p className="mt-2 break-all font-mono text-sm text-ink">{oneTime.password}</p>
          <p className="mt-2 text-xs text-muted">Paste this into QBWC once. Berrify stores only a hash.</p>
        </Card>
      ) : null}

      {message ? <p className="text-sm text-ink">{message}</p> : null}
      {error ? <p className="text-sm text-danger">Could not load QuickBooks connections.</p> : null}
      {isLoading ? <p className="text-sm text-muted">Loading connections…</p> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {targets.map((target) => {
          const connection = connectionFor(target.restaurantId);
          const online = onlineFor(target.restaurantId);
          const status = qbwcUiStatus(
            connection,
            jobs.filter((job) => job.connection_id === connection?.id),
          );
          const busy = busyKey === target.key || busyKey === connection?.id || busyKey === online?.id || busyKey === `qbo:${target.restaurantId}`;
          const onlineVendors = online ? vendors.filter((row) => row.connection_id === online.id && row.is_active) : [];
          const onlineAccounts = online ? accounts.filter((row) => row.connection_id === online.id && row.is_active) : [];
          return (
            <Card key={target.key}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-ink">{target.title}</h2>
                  <p className="mt-0.5 text-sm text-muted">{target.subtitle}</p>
                </div>
                <Badge tone={statusTone(status)} dot>
                  {qbwcStatusLabel(status)}
                </Badge>
              </div>

              {connection?.qb_company_name ? (
                <p className="mt-3 text-sm text-ink">
                  QuickBooks company: {connection.qb_company_name}
                  {connection.qb_product_name
                    ? ` · ${connection.qb_product_name} ${connection.qb_major_version ?? ""}`
                    : ""}
                </p>
              ) : null}
              {connection?.last_error ? (
                <p className="mt-2 text-sm text-danger">{connection.last_error}</p>
              ) : null}
              {connection ? (
                <p className="mt-2 text-xs text-muted">
                  Username <span className="font-mono">{connection.qb_username}</span>
                </p>
              ) : null}
              {connection
                ? (() => {
                    const vendorSync = vendorSyncSummary(connection.id, jobs, vendors);
                    const accountSync = accountSyncSummary(connection.id, jobs, accounts);
                    return (
                      <>
                        {!vendorSync.synced ? (
                          <p className="mt-2 text-xs text-muted">
                            Vendors not synced yet. After Connected, click Refresh vendors, then Update Selected.
                          </p>
                        ) : (
                          <p className="mt-2 text-xs text-muted">
                            {vendorSync.count} vendor{vendorSync.count === 1 ? "" : "s"} from Web Connector
                            {vendorSync.at ? ` · ${new Date(vendorSync.at).toLocaleString()}` : ""}
                          </p>
                        )}
                        {!accountSync.synced ? (
                          <p className="mt-2 text-xs text-muted">
                            Accounts not synced yet. After Connected, click Refresh accounts, then Update Selected.
                          </p>
                        ) : (
                          <p className="mt-2 text-xs text-muted">
                            {accountSync.count} account{accountSync.count === 1 ? "" : "s"} from Web Connector
                            {accountSync.at ? ` · ${new Date(accountSync.at).toLocaleString()}` : ""}
                          </p>
                        )}
                      </>
                    );
                  })()
                : null}

              <div className="mt-4 flex flex-wrap gap-2">
                {!connection || !connection.is_active ? (
                  <Button onClick={() => void connect(target)} disabled={busy}>
                    <Plug className="size-4" />
                    Connect QuickBooks Desktop
                  </Button>
                ) : (
                  <>
                    <Button onClick={() => void download(connection)} disabled={busy}>
                      <Download className="size-4" />
                      Download Berrify.qwc
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => void refreshVendors(connection)}
                      disabled={busy || !connection.last_connected_at}
                    >
                      <RefreshCw className="size-4" />
                      Refresh vendors
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => void refreshAccounts(connection)}
                      disabled={busy || !connection.last_connected_at}
                    >
                      <RefreshCw className="size-4" />
                      Refresh accounts
                    </Button>
                    <Button variant="outline" onClick={() => void rotate(connection)} disabled={busy}>
                      <KeyRound className="size-4" />
                      Regenerate password
                    </Button>
                    <Button variant="danger" onClick={() => void revoke(connection)} disabled={busy}>
                      <ShieldOff className="size-4" />
                      Revoke
                    </Button>
                  </>
                )}
              </div>

              {target.restaurantId ? (
                <div className="mt-4 border-t border-line pt-4">
                  <p className="text-sm font-semibold text-ink">QuickBooks Online</p>
                  {online ? (
                    <>
                      <p className="mt-2 text-sm text-ink">
                        {online.company_name || "Connected company"}
                        {online.realm_id ? ` · realm ${online.realm_id}` : ""}
                      </p>
                      <p className="mt-1 text-xs text-muted">
                        Send posts a Bill to this company. Desktop BillAdd is not queued.
                      </p>
                      <p className="mt-2 text-xs text-muted">
                        {onlineVendors.length} vendor{onlineVendors.length === 1 ? "" : "s"}
                        {" · "}
                        {onlineAccounts.length} account{onlineAccounts.length === 1 ? "" : "s"}
                        {online.last_synced_at ? ` · ${new Date(online.last_synced_at).toLocaleString()}` : ""}
                      </p>
                      {online.last_error ? <p className="mt-2 text-sm text-danger">{online.last_error}</p> : null}
                    </>
                  ) : (
                    <p className="mt-1 text-xs text-muted">
                      Separate from Desktop. Send for this restaurant uses this company only.
                    </p>
                  )}
                  {qboConfig && !qboConfig.configured ? (
                    <p className="mt-2 text-xs text-muted">
                      Connect needs Worker secrets INTUIT_CLIENT_ID and INTUIT_CLIENT_SECRET. Redirect URL:{" "}
                      {qboConfig.redirect_uri}
                    </p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {online ? (
                      <>
                        <Button variant="outline" onClick={() => void refreshOnlineVendors(online)} disabled={busy}>
                          <RefreshCw className="size-4" />
                          Refresh Online vendors
                        </Button>
                        <Button variant="outline" onClick={() => void refreshOnlineAccounts(online)} disabled={busy}>
                          <RefreshCw className="size-4" />
                          Refresh Online accounts
                        </Button>
                        <Button variant="danger" onClick={() => void disconnectOnline(online)} disabled={busy}>
                          <ShieldOff className="size-4" />
                          Disconnect QuickBooks Online
                        </Button>
                      </>
                    ) : (
                      <Button
                        onClick={() => {
                          if (target.restaurantId) void connectOnline(target.restaurantId);
                        }}
                        disabled={busy}
                      >
                        <Plug className="size-4" />
                        Connect QuickBooks Online
                      </Button>
                    )}
                  </div>
                </div>
              ) : null}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
