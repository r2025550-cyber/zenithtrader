import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { Activity, ArrowDownCircle, ArrowUpCircle, Bot, Hand, Loader2, RefreshCw, Server } from "lucide-react";

const BASE_URL = "https://virginia-cast-flood-before.trycloudflare.com";

type Mode = "AUTO" | "MANUAL" | "UNKNOWN";
type LogEntry = { id: string; ts: number; kind: "info" | "success" | "error"; text: string };

const fmtTime = (t: number) => new Date(t).toLocaleTimeString();

async function apiCall<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : (res.text() as any);
}

export default function FastApiDashboard() {
  const [mode, setMode] = useState<Mode>("UNKNOWN");
  const [serverStatus, setServerStatus] = useState<string>("Checking...");
  const [serverOnline, setServerOnline] = useState<boolean>(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState({ auto: false, manual: false, buy: false, sell: false, status: false });

  const log = useCallback((kind: LogEntry["kind"], text: string) => {
    setLogs((p) => [{ id: `${Date.now()}-${Math.random()}`, ts: Date.now(), kind, text }, ...p].slice(0, 50));
  }, []);

  const refreshStatus = useCallback(async () => {
    setLoading((s) => ({ ...s, status: true }));
    try {
      const data = await apiCall<any>("/status");
      setServerOnline(true);
      setServerStatus(data?.status || data?.message || "Online");
      const m = (data?.mode || data?.current_mode || "").toString().toUpperCase();
      if (m === "AUTO" || m === "MANUAL") setMode(m as Mode);
      log("info", `Status synced · mode=${m || "n/a"}`);
    } catch (e: any) {
      setServerOnline(false);
      setServerStatus("Offline");
      log("error", `Status fetch failed: ${e.message}`);
    } finally {
      setLoading((s) => ({ ...s, status: false }));
    }
  }, [log]);

  useEffect(() => {
    refreshStatus();
    const id = setInterval(refreshStatus, 5_000);
    return () => clearInterval(id);
  }, [refreshStatus]);

  const setModeReq = async (target: "auto" | "manual") => {
    setLoading((s) => ({ ...s, [target]: true }));
    try {
      const data = await apiCall<any>(`/mode/${target}`, { method: "POST" });
      const msg = data?.message || `${target.toUpperCase()} ENABLED`;
      setMode(target.toUpperCase() as Mode);
      toast.success(msg);
      log("success", msg);
    } catch (e: any) {
      toast.error(`Mode change failed: ${e.message}`);
      log("error", `Mode ${target} failed: ${e.message}`);
    } finally {
      setLoading((s) => ({ ...s, [target]: false }));
    }
  };

  const placeTrade = async (action: "BUY" | "SELL") => {
    const key = action.toLowerCase() as "buy" | "sell";
    setLoading((s) => ({ ...s, [key]: true }));
    try {
      const data = await apiCall<any>("/trade", {
        method: "POST",
        body: JSON.stringify({ action, symbol: "NIFTY", quantity: 1 }),
      });
      const msg = data?.message || `${action} order placed`;
      toast.success(msg);
      log("success", `${action} · ${msg}`);
    } catch (e: any) {
      toast.error(`${action} failed: ${e.message}`);
      log("error", `${action} failed: ${e.message}`);
    } finally {
      setLoading((s) => ({ ...s, [key]: false }));
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
        {/* Header */}
        <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Zenith · FastAPI Terminal</h1>
            <p className="text-sm text-muted-foreground">Direct control panel · NIFTY execution gateway</p>
          </div>
          <div className="flex items-center gap-3">
            <Badge variant={serverOnline ? "default" : "destructive"} className="gap-1.5 px-3 py-1">
              <span
                className={`h-2 w-2 rounded-full ${serverOnline ? "bg-primary-foreground animate-pulse" : "bg-destructive-foreground"}`}
              />
              {serverOnline ? "ONLINE" : "OFFLINE"}
            </Badge>
            <Button variant="terminal" size="sm" onClick={refreshStatus} disabled={loading.status}>
              {loading.status ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Refresh
            </Button>
          </div>
        </header>

        {/* Status row */}
        <div className="grid gap-4 md:grid-cols-3">
          <Card className="bg-panel">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <Server className="h-4 w-4" /> Backend
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xl font-semibold">{serverStatus}</div>
              <div className="mt-1 text-xs text-muted-foreground break-all">{BASE_URL}</div>
            </CardContent>
          </Card>

          <Card className="bg-panel">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <Activity className="h-4 w-4" /> Current Mode
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <span className="text-xl font-semibold">{mode}</span>
                {mode === "AUTO" && <Badge className="bg-accent text-accent-foreground">Bot Active</Badge>}
                {mode === "MANUAL" && <Badge variant="secondary">Manual</Badge>}
              </div>
            </CardContent>
          </Card>

          <Card className="bg-panel">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <Bot className="h-4 w-4" /> Symbol
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xl font-semibold">NIFTY</div>
              <div className="mt-1 text-xs text-muted-foreground">Qty: 1 · Market</div>
            </CardContent>
          </Card>
        </div>

        {/* Mode controls */}
        <Card className="mt-6 bg-panel">
          <CardHeader>
            <CardTitle className="text-base">Mode Control</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <Button
              size="lg"
              variant="trading"
              onClick={() => setModeReq("auto")}
              disabled={loading.auto}
              className="h-14 text-base"
            >
              {loading.auto ? <Loader2 className="animate-spin" /> : <Bot />}
              AUTO MODE
            </Button>
            <Button
              size="lg"
              variant="terminal"
              onClick={() => setModeReq("manual")}
              disabled={loading.manual}
              className="h-14 text-base"
            >
              {loading.manual ? <Loader2 className="animate-spin" /> : <Hand />}
              MANUAL MODE
            </Button>
          </CardContent>
        </Card>

        {/* Trade controls */}
        <Card className="mt-6 bg-panel">
          <CardHeader>
            <CardTitle className="text-base">Manual Execution</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <Button
              size="lg"
              onClick={() => placeTrade("BUY")}
              disabled={loading.buy}
              className="h-16 bg-profit text-profit-foreground text-lg font-bold hover:bg-profit/90 active:scale-[0.98]"
            >
              {loading.buy ? <Loader2 className="animate-spin" /> : <ArrowUpCircle />}
              BUY
            </Button>
            <Button
              size="lg"
              onClick={() => placeTrade("SELL")}
              disabled={loading.sell}
              className="h-16 bg-loss text-loss-foreground text-lg font-bold hover:bg-loss/90 active:scale-[0.98]"
            >
              {loading.sell ? <Loader2 className="animate-spin" /> : <ArrowDownCircle />}
              SELL
            </Button>
          </CardContent>
        </Card>

        {/* Logs */}
        <Card className="mt-6 bg-panel">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Trade Log</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => setLogs([])}>
              Clear
            </Button>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-72 rounded-md border border-border bg-background/40 p-3">
              {logs.length === 0 ? (
                <div className="py-12 text-center text-sm text-muted-foreground">No activity yet</div>
              ) : (
                <ul className="space-y-2 font-mono text-xs">
                  {logs.map((l) => (
                    <li key={l.id} className="flex gap-3">
                      <span className="text-muted-foreground shrink-0">{fmtTime(l.ts)}</span>
                      <span
                        className={
                          l.kind === "success" ? "text-profit" : l.kind === "error" ? "text-loss" : "text-foreground/80"
                        }
                      >
                        {l.text}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </ScrollArea>
          </CardContent>
        </Card>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Backend: secure HTTPS tunnel · Mixed-content safe.
        </p>
      </div>
    </div>
  );
}
