import { useMemo, useState } from "react";
import { Activity, Bot, ChevronDown, Gauge, IndianRupee, Radio, ShieldCheck, SlidersHorizontal, TrendingDown, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

const history = [
  { time: "09:31:22", instrument: "Nifty 22500 CE", entry: "₹132.40", exit: "₹148.10", pnl: "+₹7,850", result: "profit" },
  { time: "10:08:47", instrument: "Nifty 22400 PE", entry: "₹96.75", exit: "₹90.20", pnl: "-₹3,275", result: "loss" },
  { time: "11:42:03", instrument: "Nifty 22600 CE", entry: "₹78.15", exit: "₹85.65", pnl: "+₹3,750", result: "profit" },
  { time: "13:15:38", instrument: "Nifty 22550 PE", entry: "₹112.90", exit: "Open", pnl: "+₹1,125", result: "profit" },
];

const chartBars = [34, 48, 42, 58, 51, 64, 73, 69, 82, 76, 88, 79, 92, 85, 97, 91, 103, 96, 111, 106, 118, 109];

const Index = () => {
  const [aiEnabled, setAiEnabled] = useState(false);
  const [riskMode, setRiskMode] = useState("moderate");
  const [maxTrades, setMaxTrades] = useState(6);
  const [stopLoss, setStopLoss] = useState(2500);

  const reasoning = useMemo(() => {
    if (!aiEnabled) return "Analyzing market trends... AI engine is standing by for confirmation.";
    if (riskMode === "conservative") return "AI Suggestion: Wait for RSI to hit 60 before entering Nifty 22500 CE.";
    if (riskMode === "aggressive") return "AI Suggestion: Momentum breakout detected; trail stop loss tightly near VWAP.";
    return "AI Suggestion: Watch 22,540 resistance; enter only after volume confirmation.";
  }, [aiEnabled, riskMode]);

  return (
    <main className="min-h-screen overflow-hidden bg-terminal text-foreground">
      <div className="pointer-events-none fixed inset-0 noise-overlay opacity-30" />
      <section className="relative mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-4 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 rounded-lg border border-border bg-panel/80 p-4 shadow-panel backdrop-blur md:flex-row md:items-center md:justify-between">
          <div>
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.28em] text-muted-foreground">
              <Radio className="h-3.5 w-3.5 text-primary" /> Options Command Desk
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-normal text-foreground sm:text-3xl">Nifty Options Trading Dashboard</h1>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:min-w-[430px]">
            <div className="rounded-md border border-border bg-surface px-4 py-3">
              <p className="text-xs uppercase text-muted-foreground">Live Nifty 50</p>
              <div className="mt-1 flex items-end gap-2">
                <span className="text-2xl font-bold text-foreground">22,512.40</span>
                <span className="flex items-center text-sm font-semibold text-profit"><TrendingUp className="h-4 w-4" /> +0.42%</span>
              </div>
            </div>
            <div className="rounded-md border border-primary/30 bg-primary/10 px-4 py-3">
              <p className="text-xs uppercase text-muted-foreground">Connection Status</p>
              <div className="mt-2 flex items-center gap-2 text-sm font-semibold text-primary">
                <span className="h-2.5 w-2.5 rounded-full bg-primary animate-pulse-glow" /> Upstox API Connected
              </div>
            </div>
          </div>
        </header>

        <div className="grid gap-5 xl:grid-cols-[1.55fr_0.85fr]">
          <section className="relative min-h-[430px] overflow-hidden rounded-lg border border-border bg-panel shadow-panel">
            <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">TradingView-style chart</p>
                <h2 className="text-xl font-semibold">NIFTY 50 · 5m Options Signal</h2>
              </div>
              <div className="flex gap-2 text-xs font-semibold">
                <span className="rounded-sm border border-profit/30 bg-profit/10 px-2 py-1 text-profit">CALL Bias</span>
                <span className="rounded-sm border border-border bg-surface px-2 py-1 text-muted-foreground">Vol: High</span>
              </div>
            </div>
            <div className="market-grid relative h-[360px] p-5">
              <div className="absolute inset-y-5 right-5 flex flex-col justify-between text-xs text-muted-foreground">
                {['22,620', '22,560', '22,500', '22,440', '22,380'].map((label) => <span key={label}>{label}</span>)}
              </div>
              <div className="absolute left-0 top-1/2 h-px w-full bg-profit/40" />
              <div className="absolute left-0 top-0 h-full w-1/3 bg-gradient-to-r from-primary/10 to-transparent animate-scan motion-reduce:animate-none" />
              <div className="absolute bottom-8 left-5 right-14 flex h-64 items-end gap-2">
                {chartBars.map((height, index) => (
                  <div key={index} className="flex flex-1 items-end justify-center">
                    <span
                      className={`w-full max-w-3 rounded-t-sm ${index % 5 === 1 || index % 7 === 0 ? "bg-loss" : "bg-profit"}`}
                      style={{ height: `${height}%` }}
                    />
                  </div>
                ))}
              </div>
              <svg className="absolute bottom-8 left-5 right-14 h-64 w-[calc(100%-5.75rem)] overflow-visible" preserveAspectRatio="none" viewBox="0 0 100 100" aria-hidden="true">
                <polyline points="0,70 8,64 16,68 24,52 32,56 40,38 48,44 56,30 64,35 72,22 80,31 88,18 100,24" fill="none" stroke="hsl(var(--chart-line))" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
              </svg>
            </div>
          </section>

          <aside className="grid gap-5">
            <section className="rounded-lg border border-border bg-panel p-5 shadow-panel">
              <div className="mb-5 flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">AI Control Panel</p>
                  <h2 className="text-xl font-semibold">Autonomy Settings</h2>
                </div>
                <Bot className="h-6 w-6 text-primary" />
              </div>
              <div className="space-y-5">
                <div className="flex items-center justify-between rounded-md border border-border bg-surface p-4">
                  <div>
                    <p className="font-semibold">Start AI Trading</p>
                    <p className="text-sm text-muted-foreground">Toggle execution mode</p>
                  </div>
                  <Switch checked={aiEnabled} onCheckedChange={setAiEnabled} aria-label="Start AI Trading" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-muted-foreground">Risk Mode</label>
                  <Select value={riskMode} onValueChange={setRiskMode}>
                    <SelectTrigger className="border-border bg-surface text-foreground">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="conservative">Conservative</SelectItem>
                      <SelectItem value="moderate">Moderate</SelectItem>
                      <SelectItem value="aggressive">Aggressive</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button variant={aiEnabled ? "terminal" : "trading"} className="w-full">{aiEnabled ? "AI Trading Active" : "Arm AI Trading"}</Button>
              </div>
            </section>

            <section className="rounded-lg border border-primary/25 bg-panel p-5 shadow-market">
              <div className="mb-3 flex items-center gap-2 text-primary"><Activity className="h-5 w-5" /><h2 className="text-lg font-semibold text-foreground">Live AI Reasoning</h2></div>
              <p className="min-h-20 rounded-md border border-border bg-surface p-4 text-sm leading-6 text-muted-foreground">{reasoning}</p>
            </section>
          </aside>
        </div>

        <div className="grid gap-5 lg:grid-cols-[1.35fr_0.65fr]">
          <section className="overflow-hidden rounded-lg border border-border bg-panel shadow-panel">
            <div className="flex items-center gap-2 border-b border-border p-4"><SlidersHorizontal className="h-5 w-5 text-accent" /><h2 className="text-xl font-semibold">Trade History</h2></div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] text-left text-sm">
                <thead className="bg-surface text-xs uppercase text-muted-foreground">
                  <tr>{["Time", "Instrument", "Entry Price", "Exit Price", "P&L"].map((head) => <th key={head} className="px-4 py-3 font-semibold">{head}</th>)}</tr>
                </thead>
                <tbody>
                  {history.map((trade) => (
                    <tr key={`${trade.time}-${trade.instrument}`} className="border-t border-border transition-colors hover:bg-surface/70">
                      <td className="px-4 py-4 text-muted-foreground">{trade.time}</td>
                      <td className="px-4 py-4 font-semibold">{trade.instrument}</td>
                      <td className="px-4 py-4">{trade.entry}</td>
                      <td className="px-4 py-4">{trade.exit}</td>
                      <td className={`px-4 py-4 font-bold ${trade.result === "profit" ? "text-profit" : "text-loss"}`}>{trade.pnl}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-lg border border-border bg-panel p-5 shadow-panel">
            <div className="mb-5 flex items-center justify-between">
              <div><p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Daily Limit</p><h2 className="text-xl font-semibold">Risk Guardrails</h2></div>
              <ShieldCheck className="h-6 w-6 text-primary" />
            </div>
            <div className="space-y-5">
              <label className="block space-y-2">
                <span className="flex items-center justify-between text-sm text-muted-foreground"><span>Max Trades</span><span className="font-semibold text-foreground">{maxTrades}</span></span>
                <input className="w-full accent-primary" type="range" min="1" max="12" value={maxTrades} onChange={(event) => setMaxTrades(Number(event.target.value))} />
              </label>
              <label className="block space-y-2">
                <span className="flex items-center justify-between text-sm text-muted-foreground"><span>Stop Loss per trade</span><span className="font-semibold text-foreground">₹{stopLoss.toLocaleString("en-IN")}</span></span>
                <input className="w-full accent-primary" type="range" min="500" max="10000" step="500" value={stopLoss} onChange={(event) => setStopLoss(Number(event.target.value))} />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-md border border-border bg-surface p-3"><Gauge className="mb-2 h-5 w-5 text-warning" /><p className="text-xs text-muted-foreground">Used Today</p><p className="font-bold">4 / {maxTrades}</p></div>
                <div className="rounded-md border border-border bg-surface p-3"><IndianRupee className="mb-2 h-5 w-5 text-loss" /><p className="text-xs text-muted-foreground">Max Risk</p><p className="font-bold">₹{(stopLoss * maxTrades).toLocaleString("en-IN")}</p></div>
              </div>
            </div>
          </section>
        </div>
      </section>
    </main>
  );
};

export default Index;