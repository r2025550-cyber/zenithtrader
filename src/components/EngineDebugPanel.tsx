import { Badge } from "@/components/ui/badge";
import { Activity, AlertTriangle, CircleCheck, CircleX, Gauge, ListTree } from "lucide-react";

type ScoreRow = { label: string; weight: number; applied: boolean; contribution?: number };
type PipelineRow = { stage: string; passed: boolean; note?: string };

interface Props {
  signal: any | null;
}

/**
 * LIVE ENGINE DEBUG PANEL — all values come directly from the backend
 * `analyze-with-ai` response (`ruleContext.rules`). No simulated/fake data.
 */
export function EngineDebugPanel({ signal }: Props) {
  const rules = (signal?.ruleContext?.rules ?? {}) as Record<string, any>;
  const action = (signal?.action ?? "WAIT") as string;

  const bullScore = Number(rules.bullScore ?? 0);
  const bearScore = Number(rules.bearScore ?? 0);
  const confidenceScore = Number(rules.confidenceScore ?? 0);
  const requiredConfidence = Number(rules.requiredConfidence ?? 0);
  const regime = (rules.regime ?? "—") as string;
  const passedGate = rules.gateInfo?.passedGate ?? (confidenceScore >= requiredConfidence);
  const live = (rules.liveFactors ?? {}) as Record<string, any>;
  const breakdown = (rules.scoringBreakdown ?? []) as ScoreRow[];
  const bullFull = (rules.bullScoringFull ?? []) as ScoreRow[];
  const bearFull = (rules.bearScoringFull ?? []) as ScoreRow[];
  const pipeline = (rules.pipeline ?? []) as PipelineRow[];
  const rejectionReason = (rules.rejectionReason ?? null) as string | null;
  const gateBlocked = (rules.gateInfo?.gateBlockedReasons ?? []) as string[];
  // v15/v16 momentum scalping telemetry
  const momentumVelocityScore = Number(rules.momentumVelocityScore ?? 0);
  const entryQualityScore = Number(rules.entryQualityScore ?? 0);
  const momentumTier = (rules.momentumTier ?? "—") as string;
  const dynamicBaseGate = Number(rules.dynamicBaseGate ?? rules.baseGate ?? 0);
  const lateEntryPenalty = !!rules.lateEntryPenalty;
  const scalpingMomentumMode = !!rules.scalpingMomentumMode;
  const sessionPhase = (rules.sessionPhase ?? "—") as string;
  // v17: momentum override telemetry
  const momentumOverrideActive = !!rules.momentumOverrideActive;
  const momentumConvictionMultiplier = Number(rules.momentumConvictionMultiplier ?? 1);
  const rawConfidenceScore = Number(rules.rawConfidenceScore ?? confidenceScore);
  const trendExpansionStrength = Number(rules.trendExpansionStrength ?? 0);
  const premiumVelocity = Number(rules.premiumVelocity ?? 0);
  const momentumExhaustionRisk = !!rules.momentumExhaustionRisk;
  const sidewaysOverrideActive = !!rules.sidewaysOverrideActive;
  const baseGate = Number(rules.baseGate ?? 0);

  if (!signal) {
    return (
      <section className="rounded-lg border bg-panel p-5 shadow-market">
        <p className="text-sm text-muted-foreground">Waiting for first engine cycle…</p>
      </section>
    );
  }

  const Yes = () => <CircleCheck className="inline h-3.5 w-3.5 text-emerald-400" />;
  const No = () => <CircleX className="inline h-3.5 w-3.5 text-muted-foreground/60" />;
  const flag = (v: any) => (v ? <Yes /> : <No />);

  const factorRows: { label: string; key: string }[] = [
    { label: "EMA Bullish", key: "emaBullish" },
    { label: "EMA Bearish", key: "emaBearish" },
    { label: "Momentum Bull", key: "momentumBull" },
    { label: "Momentum Bear", key: "momentumBear" },
    { label: "Breakout Detected", key: "breakoutDetected" },
    { label: "Breakdown Detected", key: "breakdownDetected" },
    { label: "Retest Confirmed", key: "retestConfirmed" },
    { label: "Compression Active", key: "compressionActive" },
    { label: "Trap Detected", key: "trapDetected" },
    { label: "Strong Candle", key: "strongCandle" },
    { label: "Big Body", key: "bigBody" },
    { label: "Sideways Filter", key: "sidewaysFilter" },
    { label: "Near Support", key: "nearSupport" },
    { label: "Near Resistance", key: "nearResistance" },
    { label: "Spike Detected", key: "spikeDetected" },
  ];

  const allScoring = breakdown.length ? breakdown : (bullScore >= bearScore ? bullFull : bearFull);
  const directionLabel = bullScore > bearScore ? "BULL" : bearScore > bullScore ? "BEAR" : "—";

  return (
    <section className="rounded-lg border bg-panel p-5 shadow-market space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-primary">
          <Gauge className="h-5 w-5" />
          <h2 className="text-lg font-semibold text-foreground">Live Engine Debug</h2>
        </div>
        <Badge variant={passedGate ? "default" : "secondary"} className="text-[10px]">
          {passedGate ? "GATE PASSED" : "GATE BLOCKED"}
        </Badge>
      </div>

      {/* Confidence breakdown */}
      <div className="rounded-md border border-border bg-surface p-3">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Confidence Breakdown
        </p>
        <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
          <div><span className="text-muted-foreground">Bull Score:</span> <span className="font-mono tabular-nums text-foreground">{bullScore}</span></div>
          <div><span className="text-muted-foreground">Bear Score:</span> <span className="font-mono tabular-nums text-foreground">{bearScore}</span></div>
          <div><span className="text-muted-foreground">Final:</span> <span className="font-mono tabular-nums font-bold text-foreground">{confidenceScore}</span></div>
          <div><span className="text-muted-foreground">Regime Gate:</span> <span className="font-mono tabular-nums text-foreground">{requiredConfidence} ({regime})</span></div>
          <div><span className="text-muted-foreground">Passed:</span> <span className={`font-mono font-bold ${passedGate ? "text-emerald-400" : "text-amber-400"}`}>{passedGate ? "YES" : "NO"}</span></div>
        </div>
      </div>

      {/* v16 Momentum Scalping telemetry */}
      <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
        <p className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-primary">
          <span>⚡ Momentum Scalping Engine</span>
          <span className="text-foreground">{sessionPhase}</span>
        </p>
        <div className="grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
          <div>
            <div className="text-muted-foreground">Momentum Velocity</div>
            <div className={`font-mono tabular-nums font-bold ${momentumVelocityScore >= 65 ? "text-emerald-400" : momentumVelocityScore >= 45 ? "text-amber-300" : "text-muted-foreground"}`}>
              {momentumVelocityScore}/100
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Entry Quality</div>
            <div className={`font-mono tabular-nums font-bold ${entryQualityScore >= 60 ? "text-emerald-400" : entryQualityScore >= 40 ? "text-amber-300" : "text-destructive"}`}>
              {entryQualityScore}/100
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Momentum Tier</div>
            <div className={`font-mono font-bold ${momentumTier === "EXPLOSIVE" ? "text-emerald-400" : momentumTier === "CONTINUATION" ? "text-emerald-300" : momentumTier === "CHOP" ? "text-amber-400" : "text-foreground"}`}>
              {momentumTier}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Dynamic Gate</div>
            <div className="font-mono tabular-nums text-foreground">{dynamicBaseGate}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Late Entry Risk</div>
            <div className={`font-mono font-bold ${lateEntryPenalty ? "text-destructive" : "text-emerald-400"}`}>
              {lateEntryPenalty ? "BLOCKED" : "OK"}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Scalping Mode</div>
            <div className={`font-mono font-bold ${scalpingMomentumMode ? "text-emerald-400" : "text-muted-foreground"}`}>
              {scalpingMomentumMode ? "FAST" : "STD"}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Dist from EMA21</div>
            <div className="font-mono tabular-nums text-foreground">{Number(rules.distFromEma21 ?? 0).toFixed(1)}pt</div>
          </div>
          <div>
            <div className="text-muted-foreground">EMA Separation</div>
            <div className="font-mono tabular-nums text-foreground">{Number(rules.emaSeparation ?? 0).toFixed(1)}pt</div>
          </div>
        </div>
      </div>

      {/* v17 Momentum Override Layer */}
      <div className={`rounded-md border p-3 ${momentumOverrideActive ? "border-emerald-500/50 bg-emerald-500/10" : "border-border bg-surface"}`}>
        <p className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide">
          <span className={momentumOverrideActive ? "text-emerald-300" : "text-muted-foreground"}>
            🚀 Momentum Override Layer
          </span>
          <Badge variant={momentumOverrideActive ? "default" : "secondary"} className="text-[10px]">
            {momentumOverrideActive ? "OVERRIDE ON" : "OFF"}
          </Badge>
        </p>
        <div className="grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
          <div>
            <div className="text-muted-foreground">Conviction Multiplier</div>
            <div className={`font-mono tabular-nums font-bold ${momentumConvictionMultiplier >= 1.9 ? "text-emerald-400" : momentumConvictionMultiplier > 1 ? "text-emerald-300" : "text-foreground"}`}>
              ×{momentumConvictionMultiplier.toFixed(2)}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Raw → Boosted</div>
            <div className="font-mono tabular-nums text-foreground">
              {rawConfidenceScore} → <span className={momentumOverrideActive ? "text-emerald-300 font-bold" : ""}>{confidenceScore}</span>
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Gate Collapse</div>
            <div className="font-mono tabular-nums text-foreground">{baseGate} → <span className={dynamicBaseGate < baseGate ? "text-emerald-300 font-bold" : ""}>{dynamicBaseGate}</span></div>
          </div>
          <div>
            <div className="text-muted-foreground">Trend Expansion</div>
            <div className={`font-mono tabular-nums font-bold ${trendExpansionStrength >= 60 ? "text-emerald-400" : trendExpansionStrength >= 35 ? "text-amber-300" : "text-muted-foreground"}`}>
              {trendExpansionStrength}/100
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Premium Velocity</div>
            <div className={`font-mono tabular-nums font-bold ${premiumVelocity >= 30 ? "text-emerald-400" : premiumVelocity >= 15 ? "text-amber-300" : "text-foreground"}`}>
              {premiumVelocity.toFixed(1)}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Sideways Override</div>
            <div className={`font-mono font-bold ${sidewaysOverrideActive ? "text-emerald-400" : "text-muted-foreground"}`}>
              {sidewaysOverrideActive ? "BYPASSED" : "—"}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Exhaustion Risk</div>
            <div className={`font-mono font-bold ${momentumExhaustionRisk ? "text-destructive" : "text-emerald-400"}`}>
              {momentumExhaustionRisk ? "HIGH" : "LOW"}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Real Momentum</div>
            <div className={`font-mono font-bold ${momentumOverrideActive ? "text-emerald-400" : scalpingMomentumMode ? "text-emerald-300" : "text-muted-foreground"}`}>
              {momentumOverrideActive ? "EXPLOSIVE" : scalpingMomentumMode ? "ACTIVE" : "DORMANT"}
            </div>
          </div>
        </div>
      </div>


      <div className="rounded-md border border-border bg-surface p-3">
        <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Activity className="h-3.5 w-3.5" /> Live Factors
        </p>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] sm:grid-cols-3">
          {factorRows.map((r) => (
            <div key={r.key} className="flex items-center justify-between">
              <span className="text-muted-foreground">{r.label}</span>
              <span>{flag(live[r.key])}</span>
            </div>
          ))}
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">EMA Slope</span>
            <span className="font-mono tabular-nums text-foreground">{Number(live.emaSlope ?? 0).toFixed(2)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Body pts</span>
            <span className="font-mono tabular-nums text-foreground">{Number(live.bodyPts ?? 0).toFixed(1)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Volume Valid</span>
            <span className="text-muted-foreground/70 text-[10px]">{live.volumeValid === null ? "n/a" : flag(live.volumeValid)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">PCR</span>
            <span className="text-muted-foreground/70 text-[10px]">{String(live.pcrState ?? "—")}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">VIX</span>
            <span className="text-muted-foreground/70 text-[10px]">{String(live.vixState ?? "—")}</span>
          </div>
        </div>
      </div>

      {/* Scoring aggregation */}
      <div className="rounded-md border border-border bg-surface p-3">
        <p className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <span className="flex items-center gap-1.5"><ListTree className="h-3.5 w-3.5" /> Scoring Aggregation ({directionLabel})</span>
          <span className="text-foreground">FINAL = {confidenceScore}</span>
        </p>
        <ul className="space-y-0.5 font-mono text-[11px]">
          {allScoring.map((r, i) => (
            <li key={i} className={`flex items-center justify-between ${r.applied ? "text-foreground" : "text-muted-foreground/50"}`}>
              <span>
                <span className={`inline-block w-10 tabular-nums ${r.weight >= 0 ? "text-emerald-400/80" : "text-destructive/80"}`}>
                  {r.weight >= 0 ? `+${r.weight}` : r.weight}
                </span>
                {r.label}
              </span>
              <span className={r.applied ? "text-emerald-400" : "text-muted-foreground/40"}>
                {r.applied ? "ON" : "—"}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* Rejection trace */}
      {action === "WAIT" && (rejectionReason || gateBlocked.length > 0) && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
          <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5" /> Blocked Because
          </p>
          <ul className="space-y-0.5 text-[11px] text-amber-200">
            {gateBlocked.map((g, i) => <li key={`g${i}`}>• {g}</li>)}
            {rejectionReason && <li>• {rejectionReason}</li>}
            {!live.retestConfirmed && (live.breakoutDetected || live.breakdownDetected) && (
              <li>• retest missing (optional bonus, not required)</li>
            )}
            {live.bodyPts !== undefined && live.bodyPts < 12 && (
              <li>• breakout body small ({Number(live.bodyPts).toFixed(1)}pts &lt; 12)</li>
            )}
            {live.emaSlope !== undefined && Math.abs(Number(live.emaSlope)) < 15 && (
              <li>• EMA slope weak ({Number(live.emaSlope).toFixed(1)} &lt; 15)</li>
            )}
          </ul>
        </div>
      )}

      {/* Pipeline visualizer */}
      <div className="rounded-md border border-border bg-surface p-3">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Signal Flow
        </p>
        <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
          {pipeline.map((p, i) => (
            <div key={p.stage} className="flex items-center gap-1.5">
              <div className={`rounded border px-2 py-1 font-mono ${p.passed ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-amber-500/40 bg-amber-500/5 text-amber-300"}`}>
                <div className="font-semibold">{p.stage}</div>
                <div className="text-[9px] opacity-70">{p.passed ? "PASS" : "FAIL"} · {p.note}</div>
              </div>
              {i < pipeline.length - 1 && <span className="text-muted-foreground">→</span>}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
