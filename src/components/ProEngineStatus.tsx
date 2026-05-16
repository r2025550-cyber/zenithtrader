import { useEffect, useRef, useState } from "react";
import { Activity, Gauge, Layers, ShieldCheck, Timer, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";

type EngineSignal = {
  ruleContext?: {
    rules?: Record<string, any>;
    [k: string]: any;
  } | null;
  action?: string | null;
  created_at?: string | null;
};

type TradeState =
  | "IDLE" | "ANALYZING" | "WAITING_CONFIRMATION" | "SIGNAL_GENERATED"
  | "ENTRY_PENDING" | "ORDER_SENDING" | "ORDER_FILLED" | "SL_ACTIVE"
  | "TRAILING_ACTIVE" | "EXIT_PENDING" | "TRADE_CLOSED" | "COOLDOWN";

interface Props {
  signal: EngineSignal | null;
  activeTrade: boolean;
  isExecutionActive: boolean;
  exitAlertReason?: string | null;
  lastTradeAtMs?: number | null;
  minTradeGapMin?: number;
  maxTradesPerDay?: number;
  tradesToday?: number;
}

function pickState(opts: {
  activeTrade: boolean;
  exec: boolean;
  exitAlert?: string | null;
  action: string;
  cooldownActive: boolean;
}): TradeState {
  if (opts.exitAlert) return "EXIT_PENDING";
  if (opts.activeTrade && opts.exec) return "TRAILING_ACTIVE";
  if (opts.activeTrade) return "SL_ACTIVE";
  if (opts.exec) return "ORDER_SENDING";
  if (opts.action === "BUY" || opts.action === "SELL") return "SIGNAL_GENERATED";
  if (opts.cooldownActive) return "COOLDOWN";
  return "WAITING_CONFIRMATION";
}

const STATE_TONE: Record<TradeState, string> = {
  IDLE: "bg-muted text-muted-foreground",
  ANALYZING: "bg-muted text-foreground",
  WAITING_CONFIRMATION: "bg-muted text-muted-foreground",
  SIGNAL_GENERATED: "bg-primary/15 text-primary border border-primary/40",
  ENTRY_PENDING: "bg-primary/20 text-primary",
  ORDER_SENDING: "bg-primary/30 text-primary-foreground",
  ORDER_FILLED: "bg-emerald-500/20 text-emerald-400",
  SL_ACTIVE: "bg-emerald-500/15 text-emerald-400 border border-emerald-500/40",
  TRAILING_ACTIVE: "bg-emerald-500/25 text-emerald-300 border border-emerald-500/50",
  EXIT_PENDING: "bg-destructive/20 text-destructive",
  TRADE_CLOSED: "bg-muted text-foreground",
  COOLDOWN: "bg-amber-500/15 text-amber-400 border border-amber-500/40",
};

const SIGNAL_COOLDOWN_SEC = 90;

export function ProEngineStatus({
  signal,
  activeTrade,
  isExecutionActive,
  exitAlertReason,
  lastTradeAtMs,
  minTradeGapMin = 5,
  maxTradesPerDay = 8,
  tradesToday = 0,
}: Props) {
  const rules = (signal?.ruleContext?.rules ?? {}) as Record<string, any>;
  const action = (signal?.action ?? "WAIT") as string;
  const signalAt = signal?.created_at ? new Date(signal.created_at).getTime() : null;

  // Live ticker for age/cooldown timers
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const now = Date.now();
  const signalAgeSec = signalAt ? Math.max(0, Math.floor((now - signalAt) / 1000)) : null;
  const secsSinceLastTrade = lastTradeAtMs ? Math.floor((now - lastTradeAtMs) / 1000) : Infinity;
  const cooldownRemainingSec = Math.max(0, SIGNAL_COOLDOWN_SEC - secsSinceLastTrade);
  const tradeGapRemainingSec = Math.max(0, minTradeGapMin * 60 - secsSinceLastTrade);
  const cooldownActive = cooldownRemainingSec > 0;

  const confidenceScore = Number(rules.confidenceScore ?? 0);
  const aiMode = (rules.aiMode ?? rules.mode ?? "WAIT") as "HIGH_CONVICTION" | "FAST_SCALP" | "WAIT";
  const regime = (rules.regime ?? "CHOPPY") as "TRENDING" | "CHOPPY" | "COMPRESSION";
  const edgeFactors = (rules.edgeFactors ?? []) as string[];
  const rejectionReason = rules.rejectionReason as string | null | undefined;
  const supportStrength = Number(rules.supportStrength ?? 0);
  const resistanceStrength = Number(rules.resistanceStrength ?? 0);
  const bullScore = Number(rules.bullScore ?? 0);
  const bearScore = Number(rules.bearScore ?? 0);

  const tradeState = pickState({
    activeTrade,
    exec: isExecutionActive,
    exitAlert: exitAlertReason,
    action,
    cooldownActive,
  });

  const modeTone =
    aiMode === "HIGH_CONVICTION" ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
    : aiMode === "FAST_SCALP" ? "bg-primary/20 text-primary border-primary/40"
    : "bg-muted text-muted-foreground border-border";

  const regimeTone =
    regime === "TRENDING" ? "bg-primary/15 text-primary border-primary/30"
    : regime === "COMPRESSION" ? "bg-amber-500/15 text-amber-400 border-amber-500/30"
    : "bg-muted text-muted-foreground border-border";

  const dots = (n: number) => "●".repeat(Math.max(0, Math.min(3, n))) + "○".repeat(Math.max(0, 3 - n));
  const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  return (
    <section className="rounded-lg border bg-panel p-5 shadow-market">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-primary">
          <Gauge className="h-5 w-5" />
          <h2 className="text-lg font-semibold text-foreground">PRO+++ Engine Status</h2>
        </div>
        <Badge className={`text-[10px] font-semibold tracking-wide ${STATE_TONE[tradeState]}`}>
          {tradeState.replace(/_/g, " ")}
        </Badge>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {/* Confidence */}
        <div className="rounded-md border border-border bg-surface p-3">
          <div className="mb-1 flex items-center justify-between text-sm">
            <span className="inline-flex items-center gap-1.5 font-semibold text-muted-foreground">
              <Zap className="h-3.5 w-3.5" /> Confidence
            </span>
            <span className="font-bold text-foreground tabular-nums">{confidenceScore}/100</span>
          </div>
          <Progress value={confidenceScore} className="h-2" />
          <p className="mt-2 text-[11px] text-muted-foreground">
            Bull {bullScore} · Bear {bearScore}
          </p>
        </div>

        {/* AI Mode */}
        <div className="rounded-md border border-border bg-surface p-3">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="inline-flex items-center gap-1.5 font-semibold text-muted-foreground">
              <Activity className="h-3.5 w-3.5" /> AI Mode
            </span>
            <Badge className={`border text-[10px] ${modeTone}`}>{aiMode.replace("_", " ")}</Badge>
          </div>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Layers className="h-3 w-3" /> Regime
            </span>
            <Badge className={`border text-[10px] ${regimeTone}`}>{regime}</Badge>
          </div>
        </div>

        {/* Signal age + cooldown */}
        <div className="rounded-md border border-border bg-surface p-3">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="inline-flex items-center gap-1.5 font-semibold text-muted-foreground">
              <Timer className="h-3.5 w-3.5" /> Signal Age
            </span>
            <span className="font-bold text-foreground tabular-nums">
              {signalAgeSec === null ? "—" : fmtTime(signalAgeSec)}
            </span>
          </div>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Cooldown</span>
            <span className="tabular-nums">{cooldownActive ? fmtTime(cooldownRemainingSec) : "ready"}</span>
          </div>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Trade gap</span>
            <span className="tabular-nums">
              {tradeGapRemainingSec > 0 ? fmtTime(tradeGapRemainingSec) : "ready"}
            </span>
          </div>
        </div>

        {/* S/R strength + day count */}
        <div className="rounded-md border border-border bg-surface p-3">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="inline-flex items-center gap-1.5 font-semibold text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5" /> S / R Strength
            </span>
            <span className="font-mono text-xs text-foreground">
              S {dots(supportStrength)} · R {dots(resistanceStrength)}
            </span>
          </div>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Trades today</span>
            <span className="tabular-nums">{tradesToday} / {maxTradesPerDay}</span>
          </div>
        </div>
      </div>

      {/* Edge factors */}
      {edgeFactors.length > 0 && (
        <div className="mt-3">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Active edge factors
          </p>
          <div className="flex flex-wrap gap-1.5">
            {edgeFactors.map((f) => (
              <Badge key={f} variant="outline" className="text-[10px]">
                {f}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* Rejection reason */}
      {action === "WAIT" && rejectionReason && (
        <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-300">
          <span className="font-semibold">Last block: </span>
          {rejectionReason}
        </p>
      )}
    </section>
  );
}

/**
 * Hook: persist S/R + reasoning across AI polls.
 * - S/R held ≥ 3 minutes (only replaced if newer value present)
 * - Reasoning held ≥ 30 seconds
 */
export function usePersistedEngineState(opts: {
  support: number | null;
  resistance: number | null;
  reasoning: string;
  action: string;
  executionActive: boolean;
}) {
  const srRef = useRef<{ s: number | null; r: number | null; ts: number }>({ s: null, r: null, ts: 0 });
  const reasonRef = useRef<{ text: string; ts: number }>({ text: "", ts: 0 });
  const now = Date.now();

  // S/R cache (3 min)
  if (opts.support !== null || opts.resistance !== null) {
    srRef.current = {
      s: opts.support ?? srRef.current.s,
      r: opts.resistance ?? srRef.current.r,
      ts: now,
    };
  }
  const srAgeMs = now - srRef.current.ts;
  const lockS = opts.executionActive || srAgeMs < 180_000;
  const support = (opts.support === null && lockS) ? srRef.current.s : opts.support;
  const resistance = (opts.resistance === null && lockS) ? srRef.current.r : opts.resistance;

  // Reasoning cache (30s) — never blank during active execution
  const incoming = (opts.reasoning ?? "").trim();
  if (incoming.length > 0) {
    const lockR = opts.executionActive || (now - reasonRef.current.ts) < 30_000;
    if (!lockR || reasonRef.current.text === "") {
      reasonRef.current = { text: incoming, ts: now };
    }
  }
  const reasoning = reasonRef.current.text || incoming || "Waiting for fresh market analysis…";

  return { support, resistance, reasoning };
}
