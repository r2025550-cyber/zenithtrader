import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Bot,
  CheckCircle2,
  Gauge,
  IndianRupee,
  KeyRound,
  LogIn,
  ExternalLink,
  Radio,
  RefreshCw,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  TrendingUp,
  XCircle,
} from "lucide-react";
import { Session } from "@supabase/supabase-js";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { lovable } from "@/integrations/lovable";
import { supabase } from "@/integrations/supabase/client";

const history = [
  { time: "09:31:22", instrument: "Nifty 22500 CE", entry: "₹132.40", exit: "₹148.10", pnl: "+₹7,850", result: "profit" },
  { time: "10:08:47", instrument: "Nifty 22400 PE", entry: "₹96.75", exit: "₹90.20", pnl: "-₹3,275", result: "loss" },
  { time: "11:42:03", instrument: "Nifty 22600 CE", entry: "₹78.15", exit: "₹85.65", pnl: "+₹3,750", result: "profit" },
  { time: "13:15:38", instrument: "Nifty 22550 PE", entry: "₹112.90", exit: "Open", pnl: "+₹1,125", result: "profit" },
];

const UPSTOX_OAUTH_REDIRECT_URI = "http://localhost:3000";
const UPSTOX_INVALID_CODE_ERROR = "UDAPI100057";
const UPSTOX_INVALID_TOKEN_ERROR = "UDAPI100050";
const AI_ARMED_STORAGE_KEY = "zenith-ai-trading-armed";
const TRADING_LOT_SIZE_STORAGE_KEY = "zenith-trading-lot-size";
const DAILY_TARGET_STORAGE_KEY = "zenith-daily-profit-target";
const MAX_DAILY_LOSS_STORAGE_KEY = "zenith-max-daily-loss";
const TRADE_COUNT_STORAGE_KEY = "zenith-trade-count-date";
const ACTIVE_TRADE_STORAGE_KEY = "zenith-active-trade-date";
const ACTIVE_TRADE_PLAN_STORAGE_KEY = "zenith-active-trade-plan-date";
const KILL_SWITCH_STORAGE_KEY = "zenith-kill-switch-date";
const COOLDOWN_UNTIL_STORAGE_KEY = "zenith-cooldown-until";
const MARKET_OPEN_MINUTE = 9 * 60 + 15;
const MARKET_CLOSE_MINUTE = 15 * 60 + 30;
const AUTO_SQUAREOFF_MINUTE = 15 * 60 + 15;
const UPSTOX_POLL_INTERVAL_MS = 5_000;
const AI_REASONING_INTERVAL_MS = 30_000;
const NIFTY_LOT_SIZE = 65;
const MAX_TRADES_PER_DAY = 4;
const DAILY_STOP_LOSS = 2000;
const DEFAULT_PREMIUM_TARGET_POINTS = 25;
const DEFAULT_PREMIUM_SL_POINTS = 15;
const PREMIUM_TSL_STEP = 5;
const COOLDOWN_MS = 15 * 60 * 1000;

const getIndiaMarketMinute = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
};

const isWithinMarketHours = (date = new Date()) => {
  const minute = getIndiaMarketMinute(date);
  return minute >= MARKET_OPEN_MINUTE && minute <= MARKET_CLOSE_MINUTE;
};

const storedValue = (key: string, fallback = "") => (typeof window === "undefined" ? fallback : localStorage.getItem(key) ?? fallback);
const todayKey = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const datedStorageValue = (key: string, fallback = "0") => {
  const [date, value] = storedValue(key).split(":");
  return date === todayKey() ? value || fallback : fallback;
};
const parseCurrency = (value: string) => Number(value.replace(/[^0-9.-]/g, "")) || 0;
const parseActiveTradePlan = () => {
  try {
    const stored = storedValue(ACTIVE_TRADE_PLAN_STORAGE_KEY);
    const separator = stored.indexOf(":");
    const date = separator >= 0 ? stored.slice(0, separator) : "";
    const payload = separator >= 0 ? stored.slice(separator + 1) : "";
    return date === todayKey() && payload ? JSON.parse(payload) : null;
  } catch {
    return null;
  }
};
const toNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const formatMoney = (value: unknown) => {
  const parsed = toNumber(value);
  return parsed === null ? "—" : `₹${parsed.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
};
const clampMeter = (value: number | null, max: number) => value === null ? 0 : Math.min(100, Math.max(0, (value / max) * 100));

type RuleContext = { rules?: { volumeValid?: boolean | null; fakeBreakout?: boolean; vixRising?: boolean; vixMovePct?: number | null; vixSizeCut?: boolean; europeanOpenCaution?: boolean; overextended?: boolean; noTradeRange?: boolean; divergence?: boolean; pcr?: number | null; pcrState?: string; emaAligned?: boolean; emaTrend?: string; multiTimeframeAligned?: boolean; trend15?: string; entry1m?: string } };
type Signal = { action: string; strike: string; reason: string; conviction?: "HIGH" | "MEDIUM" | "LOW"; highProbability?: boolean; ruleContext?: RuleContext; created_at?: string; tradingLotSize?: number; effectiveLotSize?: number; effectiveTradingQuantity?: number; riskSizeDown?: boolean };
type NiftyData = { ltp?: number | string | null; open_price?: number | string | null; high_price?: number | string | null; low_price?: number | string | null; close_price?: number | string | null; raw_payload?: { volume?: number | string | null; optionChain?: { pcr?: number | string | null }; account?: { margin?: { availableCash?: number | string | null; usedMargin?: number | string | null }; todayPnl?: number | string | null } ; context?: { indiaVix?: { ltp?: number | string | null }; bankNifty?: { ltp?: number | string | null }; heavyweights?: Array<{ ltp?: number | string | null }> } }; created_at?: string; source_timestamp?: string };
type MarketPoint = { value: number; time: string };
type PulseCheck = { ok: boolean; message: string; details?: Record<string, unknown> };
type SystemStatus = { ready: boolean; upstox: PulseCheck; gemini: PulseCheck; checkedAt: string };
type OpenAIStatus = { gemini: PulseCheck; checkedAt: string };
type UpstoxStatus = { upstox: PulseCheck; checkedAt: string };
type ActiveTradePlan = { action: "BUY" | "SELL"; entry: number; target: number; stopLoss: number; strike: string; quantity: number; initialTargetPoints: number; initialSlPoints: number; instrumentToken?: string; slOrderId?: string; entryPremium?: number; currentPremium?: number; targetPremium?: number; stopLossPremium?: number; lastSyncedStopLossPremium?: number; exitAlertReason?: "TRAILING_SL" | "FINAL_TARGET" } | null;
type LiveOrderResult = { success: boolean; instrument: { tradingSymbol: string; strike: number; optionType: string }; instrumentToken?: string; quantity: number; availableCash: number; requiredCash: number; entryPremium: number; targetPremium: number; stopLossPremium: number; slOrderId?: string };

const calculateVolatilityPoints = (points: MarketPoint[]) => {
  const recent = points.slice(-12).map((point) => point.value);
  if (recent.length < 4) return { targetPoints: DEFAULT_PREMIUM_TARGET_POINTS, slPoints: DEFAULT_PREMIUM_SL_POINTS };
  const range = Math.max(...recent) - Math.min(...recent);
  const targetPoints = Math.max(DEFAULT_PREMIUM_TARGET_POINTS, Math.ceil(range / 20) * 5);
  const slPoints = Math.max(DEFAULT_PREMIUM_SL_POINTS, Math.ceil(targetPoints * 0.6));
  return { targetPoints, slPoints };
};

const Index = () => {
  const { toast } = useToast();
  const marketIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const aiIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const alertIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const retryToastRef = useRef(0);
  const lastSignalAutofillRef = useRef("");
  const [session, setSession] = useState<Session | null>(null);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [aiEnabled, setAiEnabled] = useState(() => storedValue(AI_ARMED_STORAGE_KEY) === "true" && isWithinMarketHours());
  const [riskMode, setRiskMode] = useState("moderate");
  const [tradingLotSize, setTradingLotSize] = useState(() => storedValue(TRADING_LOT_SIZE_STORAGE_KEY, "1"));
  const [executedTrades, setExecutedTrades] = useState(() => Number.parseInt(datedStorageValue(TRADE_COUNT_STORAGE_KEY), 10) || 0);
  const [activeTrade, setActiveTrade] = useState(() => datedStorageValue(ACTIVE_TRADE_STORAGE_KEY) === "true");
  const [activeTradePlan, setActiveTradePlan] = useState<ActiveTradePlan>(() => parseActiveTradePlan());
  const [userTargetPoints, setUserTargetPoints] = useState("");
  const [userSlPoints, setUserSlPoints] = useState("");
  const [dailyProfitTarget, setDailyProfitTarget] = useState(() => storedValue(DAILY_TARGET_STORAGE_KEY, "15000"));
  const [maxDailyLoss, setMaxDailyLoss] = useState(() => storedValue(MAX_DAILY_LOSS_STORAGE_KEY, String(DAILY_STOP_LOSS)));
  const [killSwitchDate, setKillSwitchDate] = useState(() => storedValue(KILL_SWITCH_STORAGE_KEY));
  const [cooldownUntil, setCooldownUntil] = useState(() => Number(storedValue(COOLDOWN_UNTIL_STORAGE_KEY, "0")) || 0);
  const [settings, setSettings] = useState({ upstoxApiKey: "", upstoxApiSecret: "", openaiApiKey: "", redirectUri: UPSTOX_OAUTH_REDIRECT_URI });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [oauthCode, setOauthCode] = useState("");
  const [authorizationUrl, setAuthorizationUrl] = useState("");
  const [oauthDebugLog, setOauthDebugLog] = useState("No token exchange attempted yet.");
  const [latestData, setLatestData] = useState<NiftyData | null>(null);
  const [marketHistory, setMarketHistory] = useState<MarketPoint[]>([]);
  const [latestSignal, setLatestSignal] = useState<Signal | null>(null);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [isCheckingStatus, setIsCheckingStatus] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [exitFlashUntil, setExitFlashUntil] = useState(0);
  const [marketClock, setMarketClock] = useState(() => new Date());

  const latestLtp = Number(latestData?.ltp);
  const hasLivePrice = Number.isFinite(latestLtp);
  const chartValues = marketHistory.map((point) => point.value);
  const chartMin = chartValues.length ? Math.min(...chartValues) : 0;
  const chartMax = chartValues.length ? Math.max(...chartValues) : 0;
  const chartRange = Math.max(chartMax - chartMin, 1);
  const chartLevels = Array.from({ length: 5 }, (_, index) => chartMax - (chartRange * index) / 4);
  const chartBars = marketHistory.map((point) => Math.max(8, ((point.value - chartMin) / chartRange) * 88 + 8));
  const chartPolyline = marketHistory
    .map((point, index) => {
      const x = marketHistory.length === 1 ? 100 : (index / (marketHistory.length - 1)) * 100;
      const y = 96 - ((point.value - chartMin) / chartRange) * 88;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  const marketIsOpen = isWithinMarketHours(marketClock);
  const connectionLabel = !session ? "Sign In Required" : systemStatus?.ready ? (marketIsOpen ? "System Live (Market Open)" : "System Ready (Market Closed)") : "Action Required";
  const connectionTone = !session ? "text-muted-foreground" : systemStatus?.ready ? (marketIsOpen ? "text-profit" : "text-primary") : "text-loss";
  const connectionDot = !session ? "bg-muted-foreground" : systemStatus?.ready ? (marketIsOpen ? "bg-profit" : "bg-primary") : "bg-loss";
  const highProbabilitySignal = Boolean(latestSignal?.highProbability);
  const normalizedTradingLotSize = Math.max(1, Number.parseInt(tradingLotSize, 10) || 1);
  const totalTradingQuantity = normalizedTradingLotSize * NIFTY_LOT_SIZE;
  const pcrValue = toNumber(latestSignal?.ruleContext?.rules?.pcr ?? latestData?.raw_payload?.optionChain?.pcr);
  const vixValue = toNumber(latestData?.raw_payload?.context?.indiaVix?.ltp);
  const suggestedQuantity = latestSignal?.riskSizeDown ? Math.max(NIFTY_LOT_SIZE, latestSignal.effectiveTradingQuantity ?? Math.floor(totalTradingQuantity / 2)) : totalTradingQuantity;
  const aiPanelTone = latestSignal?.action === "BUY" ? "animate-pulse border-profit/70 shadow-[0_0_24px_hsl(var(--profit)/0.22)]" : latestSignal?.action === "WAIT" ? "border-warning/70" : highProbabilitySignal ? "animate-golden-blink border-warning/70" : "border-primary/25";
  const aiTextTone = latestSignal?.action === "BUY" ? "border-profit/60 text-foreground" : latestSignal?.action === "WAIT" ? "border-warning/70 text-foreground" : highProbabilitySignal ? "border-warning/70 text-foreground" : "border-border text-muted-foreground";
  const upstoxTodayPnl = toNumber(latestData?.raw_payload?.account?.todayPnl);
  const dailyPnl = upstoxTodayPnl ?? 0;
  const availableCash = toNumber(latestData?.raw_payload?.account?.margin?.availableCash) ?? 0;
  const upstoxReady = systemStatus?.upstox?.ok === true;
  const upstoxNeedsSetup = session && systemStatus?.upstox?.ok === false;
  const normalizedDailyTarget = Math.max(0, Number.parseInt(dailyProfitTarget, 10) || 0);
  const normalizedMaxDailyLoss = DAILY_STOP_LOSS;
  const tradesRemaining = Math.max(0, MAX_TRADES_PER_DAY - executedTrades);
  const maxTradesHit = executedTrades >= MAX_TRADES_PER_DAY;
  const targetAchieved = normalizedDailyTarget > 0 && dailyPnl >= normalizedDailyTarget;
  const hardKillActive = killSwitchDate === todayKey() || dailyPnl <= -DAILY_STOP_LOSS;
  const cooldownActive = cooldownUntil > Date.now();
  const cooldownRemainingMinutes = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 60_000));
  const tradingBlocked = targetAchieved || hardKillActive || maxTradesHit || cooldownActive;
  const currentTradePnlPoints = activeTradePlan?.entryPremium && activeTradePlan?.currentPremium ? activeTradePlan.currentPremium - activeTradePlan.entryPremium : 0;
  const currentTradePnlMoney = activeTradePlan ? currentTradePnlPoints * activeTradePlan.quantity : 0;
  const exitAlertActive = Boolean(activeTradePlan?.exitAlertReason) || exitFlashUntil > Date.now();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession));
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const clock = setInterval(() => setMarketClock(new Date()), 30_000);
    return () => clearInterval(clock);
  }, []);

  useEffect(() => {
    localStorage.setItem(TRADING_LOT_SIZE_STORAGE_KEY, tradingLotSize);
  }, [tradingLotSize]);

  useEffect(() => {
    localStorage.setItem(DAILY_TARGET_STORAGE_KEY, dailyProfitTarget);
    localStorage.setItem(MAX_DAILY_LOSS_STORAGE_KEY, maxDailyLoss);
  }, [dailyProfitTarget, maxDailyLoss]);

  useEffect(() => {
    if (hardKillActive && killSwitchDate !== todayKey()) {
      const today = todayKey();
      setKillSwitchDate(today);
      localStorage.setItem(KILL_SWITCH_STORAGE_KEY, today);
      emergencyExit(true);
    }
    if (tradingBlocked && aiEnabled) {
      setAiEnabled(false);
      localStorage.setItem(AI_ARMED_STORAGE_KEY, "false");
      toast({ title: cooldownActive ? "Cooldown Active" : targetAchieved ? "Target Achieved" : hardKillActive ? "Hard Kill-Switch Active" : "Max Trades Reached", description: cooldownActive ? `AI trading paused for ${cooldownRemainingMinutes} more minutes.` : targetAchieved ? "Daily profit target reached. AI trading is stopped for the day." : hardKillActive ? "₹2000 daily stop loss reached. Trading is locked for the day." : "4-trade daily cap reached. AI trading is stopped for the day.", variant: targetAchieved || cooldownActive ? "default" : "destructive" });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTrade, aiEnabled, cooldownActive, cooldownRemainingMinutes, hardKillActive, killSwitchDate, maxTradesHit, targetAchieved, toast, tradingBlocked]);

  useEffect(() => {
    if (!latestSignal || latestSignal.action !== "BUY" || activeTrade) return;
    const signalKey = `${latestSignal.created_at ?? ""}-${latestSignal.action}-${latestSignal.strike}`;
    if (signalKey === lastSignalAutofillRef.current) return;
    lastSignalAutofillRef.current = signalKey;
    const { targetPoints, slPoints } = calculateVolatilityPoints(marketHistory);
    setUserTargetPoints(String(targetPoints));
    setUserSlPoints(String(slPoints));
  }, [activeTrade, latestSignal, marketHistory]);

  useEffect(() => {
    if (!activeTradePlan?.entryPremium || !activeTradePlan.currentPremium || activeTradePlan.exitAlertReason) return;
    const premiumProfit = activeTradePlan.currentPremium - activeTradePlan.entryPremium;
    const stopHit = activeTradePlan.currentPremium <= (activeTradePlan.stopLossPremium ?? activeTradePlan.stopLoss);
    const targetHit = activeTradePlan.currentPremium >= (activeTradePlan.targetPremium ?? activeTradePlan.target);
    if (stopHit) {
      const nextPlan = { ...activeTradePlan, exitAlertReason: "TRAILING_SL" as const };
      setExitFlashUntil(Date.now() + 10_000);
      setActiveTradePlan(nextPlan);
      localStorage.setItem(ACTIVE_TRADE_PLAN_STORAGE_KEY, `${todayKey()}:${JSON.stringify(nextPlan)}`);
      emergencyExit(false);
      return;
    }
    if (targetHit) {
      const nextPlan = { ...activeTradePlan, exitAlertReason: "FINAL_TARGET" as const };
      setExitFlashUntil(Date.now() + 10_000);
      setActiveTradePlan(nextPlan);
      localStorage.setItem(ACTIVE_TRADE_PLAN_STORAGE_KEY, `${todayKey()}:${JSON.stringify(nextPlan)}`);
      emergencyExit(false);
      return;
    }
    if (premiumProfit >= PREMIUM_TSL_STEP) {
      const lockedSteps = Math.floor(premiumProfit / PREMIUM_TSL_STEP);
      const candidateStop = activeTradePlan.entryPremium - activeTradePlan.initialSlPoints + lockedSteps * PREMIUM_TSL_STEP;
      if (candidateStop > (activeTradePlan.stopLossPremium ?? 0)) {
        const nextPlan = { ...activeTradePlan, stopLossPremium: candidateStop, stopLoss: candidateStop };
        setActiveTradePlan(nextPlan);
        setUserSlPoints(String(Math.max(0, nextPlan.entryPremium - candidateStop)));
        localStorage.setItem(ACTIVE_TRADE_PLAN_STORAGE_KEY, `${todayKey()}:${JSON.stringify(nextPlan)}`);
        syncStopLossPremium(nextPlan).catch((error) => showRetryToast(error instanceof Error ? error.message : "Server SL modify will retry."));
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTradePlan]);

  const handleTargetPointsChange = (value: string) => {
    setUserTargetPoints(value);
    const points = Number(value);
    if (!activeTradePlan || !Number.isFinite(points) || points <= 0) return;
    const nextPlan = { ...activeTradePlan, targetPremium: (activeTradePlan.entryPremium ?? activeTradePlan.entry) + points, target: (activeTradePlan.entryPremium ?? activeTradePlan.entry) + points, initialTargetPoints: points };
    setActiveTradePlan(nextPlan);
    localStorage.setItem(ACTIVE_TRADE_PLAN_STORAGE_KEY, `${todayKey()}:${JSON.stringify(nextPlan)}`);
  };

  const handleSlPointsChange = (value: string) => {
    setUserSlPoints(value);
    const points = Number(value);
    if (!activeTradePlan || !Number.isFinite(points) || points < 0) return;
    const nextPlan = { ...activeTradePlan, stopLossPremium: Math.max(0.05, (activeTradePlan.entryPremium ?? activeTradePlan.entry) - points), stopLoss: Math.max(0.05, (activeTradePlan.entryPremium ?? activeTradePlan.entry) - points), initialSlPoints: points };
    setActiveTradePlan(nextPlan);
    localStorage.setItem(ACTIVE_TRADE_PLAN_STORAGE_KEY, `${todayKey()}:${JSON.stringify(nextPlan)}`);
    syncStopLossPremium(nextPlan).catch((error) => showRetryToast(error instanceof Error ? error.message : "Server SL modify will retry."));
  };

  const playAlertTone = () => {
    const AudioCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) return;
    const context = audioContextRef.current ?? new AudioCtor();
    audioContextRef.current = context;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "square";
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.42);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.45);
  };

  useEffect(() => {
    if (alertIntervalRef.current) clearInterval(alertIntervalRef.current);
    if (exitAlertActive) {
      playAlertTone();
      alertIntervalRef.current = setInterval(playAlertTone, 900);
    }
    return () => {
      if (alertIntervalRef.current) clearInterval(alertIntervalRef.current);
    };
  }, [exitAlertActive]);

  useEffect(() => {
    if (!exitFlashUntil) return;
    const timeout = setTimeout(() => setExitFlashUntil(0), Math.max(0, exitFlashUntil - Date.now()));
    return () => clearTimeout(timeout);
  }, [exitFlashUntil]);

  useEffect(() => {
    if (!activeTradePlan?.instrumentToken || activeTradePlan.exitAlertReason) return;
    const pollPremium = () => {
      invokeFunction<{ premium: number }>("fetch-option-premium", { instrumentToken: activeTradePlan.instrumentToken })
        .then(({ premium }) => {
          setActiveTradePlan((current) => {
            if (!current) return current;
            const nextPlan = { ...current, currentPremium: premium };
            localStorage.setItem(ACTIVE_TRADE_PLAN_STORAGE_KEY, `${todayKey()}:${JSON.stringify(nextPlan)}`);
            return nextPlan;
          });
        })
        .catch((error) => showRetryToast(error instanceof Error ? error.message : "Unable to refresh option premium."));
    };
    pollPremium();
    const timer = setInterval(pollPremium, UPSTOX_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTradePlan?.instrumentToken, activeTradePlan?.exitAlertReason]);

  useEffect(() => {
    if (!activeTrade || getIndiaMarketMinute(marketClock) < AUTO_SQUAREOFF_MINUTE) return;
    emergencyExit(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTrade, marketClock]);

  const showRetryToast = (message: string) => {
    const now = Date.now();
    if (now - retryToastRef.current < 20_000) return;
    retryToastRef.current = now;
    toast({ title: "Retrying Connection...", description: message });
  };

  const reasoning = useMemo(() => {
    if (latestSignal) {
      const rules = latestSignal.ruleContext?.rules;
      const triggered = [
        rules?.fakeBreakout && "POTENTIAL TRAP",
        rules?.vixRising && "VIX risk size-down",
        rules?.europeanOpenCaution && "European open caution",
        rules?.overextended && "Overextended Zone",
        rules?.noTradeRange && "No-Trade Zone",
        rules?.divergence && "Low Conviction divergence",
        rules?.volumeValid && "Volume +20% confirmed",
        rules?.emaAligned && `EMA ${rules.emaTrend} aligned`,
        rules?.multiTimeframeAligned && `15m confirms 1m ${rules.entry1m}`,
        rules?.vixSizeCut && "VIX >5% size -50%",
        rules?.pcrState && `PCR ${rules.pcrState}`,
      ].filter(Boolean).join(" · ");
      return `AI Suggestion: ${latestSignal.action} ${latestSignal.strike} · ${latestSignal.conviction ?? "MEDIUM"} Conviction${triggered ? ` · ${triggered}` : ""} — ${latestSignal.reason}`;
    }
    if (targetAchieved) return "Target Achieved: daily profit goal reached. AI trading is stopped for the day.";
    if (hardKillActive) return "Hard Kill-Switch Active: max daily loss reached. Trading is disabled for the day.";
    if (!aiEnabled) return "Analyzing market trends... AI engine is standing by for confirmation.";
    if (riskMode === "conservative") return "AI loop armed: waiting for high-confidence RSI and trend confirmation.";
    if (riskMode === "aggressive") return "AI loop armed: scanning momentum breakouts with tight VWAP risk control.";
    return "AI loop armed: streaming Upstox prices every 5 seconds while OpenAI confirms trend every 30 seconds.";
  }, [aiEnabled, hardKillActive, latestSignal, riskMode, targetAchieved]);

  const signIn = async (event: FormEvent) => {
    event.preventDefault();
    const { error } = await supabase.auth.signInWithPassword({ email: authEmail, password: authPassword });
    if (error) {
      const signup = await supabase.auth.signUp({ email: authEmail, password: authPassword });
      if (signup.error) toast({ title: "Authentication failed", description: signup.error.message, variant: "destructive" });
      else toast({ title: "Check your inbox", description: "Confirm your email, then sign in to manage trading settings." });
    }
  };

  const signInWithGoogle = async () => {
    const result = await lovable.auth.signInWithOAuth("google", { redirect_uri: window.location.origin });
    if (result.error) toast({ title: "Google sign-in failed", description: result.error.message, variant: "destructive" });
  };

  const invokeFunction = async <T,>(name: string, body?: Record<string, unknown>) => {
    const { data, error } = await supabase.functions.invoke<T>(name, { body });
    if (error) {
      const message = error.message.includes(UPSTOX_INVALID_CODE_ERROR)
        ? "Invalid Auth code. Upstox authorization codes are single-use; tap Get Code and paste a brand-new code."
        : error.message.includes(UPSTOX_INVALID_TOKEN_ERROR) || error.message.toLowerCase().includes("upstox oauth reconnect required")
          ? "Upstox OAuth reconnect required. Open API Settings, tap Get Code, finish Upstox login, paste the fresh code, then Connect."
        : error.message;
      throw new Error(message);
    }
    return data;
  };

  const withTimeout = async <T,>(promise: Promise<T>, ms: number, message: string) => {
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(message)), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timeoutId!);
    }
  };

  const syncStopLossPremium = async (plan: NonNullable<ActiveTradePlan>) => {
    if (!plan.slOrderId || !plan.stopLossPremium || plan.lastSyncedStopLossPremium === plan.stopLossPremium) return;
    await invokeFunction("modify-stop-loss-order", { orderId: plan.slOrderId, quantity: plan.quantity, triggerPrice: plan.stopLossPremium });
    const nextPlan = { ...plan, lastSyncedStopLossPremium: plan.stopLossPremium };
    setActiveTradePlan(nextPlan);
    localStorage.setItem(ACTIVE_TRADE_PLAN_STORAGE_KEY, `${todayKey()}:${JSON.stringify(nextPlan)}`);
    toast({ title: "Server SL updated", description: `Upstox SL-M trigger moved to ₹${plan.stopLossPremium.toFixed(2)}.` });
  };

  const saveUpstoxSettings = async () => {
    setIsBusy(true);
    try {
      await invokeFunction("save-trading-settings", { provider: "upstox", upstoxApiKey: settings.upstoxApiKey, upstoxApiSecret: settings.upstoxApiSecret, redirectUri: settings.redirectUri });
      setSettings((prev) => ({ ...prev, upstoxApiKey: "", upstoxApiSecret: "" }));
      toast({ title: "Upstox keys saved", description: "Existing OpenAI settings were left unchanged. Complete OAuth if the token needs reconnecting." });
      await retestUpstox(false).catch(() => null);
    } catch (error) {
      toast({ title: "Unable to save Upstox", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
    } finally {
      setIsBusy(false);
    }
  };

  const saveOpenAISettings = async (event: FormEvent) => {
    event.preventDefault();
    setIsBusy(true);
    try {
      await invokeFunction("save-trading-settings", { provider: "openai", openaiApiKey: settings.openaiApiKey });
      setSettings((prev) => ({ ...prev, openaiApiKey: "" }));
      const status = await retestOpenAI(false).catch(() => null);
      toast({ title: status?.gemini.ok ? "OpenAI verified" : "OpenAI key saved", description: status?.gemini.message ?? "Existing Upstox token and settings were left unchanged." });
    } catch (error) {
      toast({ title: "Unable to save OpenAI", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
    } finally {
      setIsBusy(false);
    }
  };

  const startUpstoxOAuth = async () => {
    try {
      const redirectUri = UPSTOX_OAUTH_REDIRECT_URI;
      const data = await invokeFunction<{ url: string }>("upstox-oauth", { mode: "url", redirectUri });
      setAuthorizationUrl(data.url);
      setSettings((prev) => ({ ...prev, redirectUri }));
      setOauthCode("");
      setOauthDebugLog(`Fresh Authorization URL generated.\nredirect_uri=${redirectUri}\nEncoded redirect_uri=${encodeURIComponent(redirectUri)}\nPaste only the new code from this login attempt.`);
      window.open(data.url, "_blank", "noopener,noreferrer");
      toast({ title: "Upstox login opened", description: "After login, copy the code value from the redirected URL bar and paste it back here." });
    } catch (error) {
      toast({ title: "OAuth start failed", description: error instanceof Error ? error.message : "Save settings first.", variant: "destructive" });
    }
  };

  const completeUpstoxOAuth = async () => {
    const debugRedirectUri = UPSTOX_OAUTH_REDIRECT_URI;
    const trimmedCode = oauthCode.trim();
    setOauthDebugLog(`Token exchange payload sent to Upstox:\nmode=token\ncode=${trimmedCode}\nredirect_uri=${debugRedirectUri}\nUse a fresh OAuth code for each retry.`);
    try {
      await invokeFunction("upstox-oauth", { mode: "token", code: trimmedCode, redirectUri: debugRedirectUri });
      setOauthCode("");
      setOauthDebugLog(`Token exchange succeeded.\ncode=${trimmedCode}\nredirect_uri=${debugRedirectUri}\nThis code has now been used and cannot be submitted again.`);
      await checkSystemStatus(false).catch(() => null);
      await fetchLiveNifty(false, true);
      toast({ title: "Upstox connected", description: "Access token saved securely for server-side market data calls." });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Check the authorization code.";
      const isInvalidCode = message.includes(UPSTOX_INVALID_CODE_ERROR) || message.toLowerCase().includes("invalid auth code");
      if (isInvalidCode) {
        setOauthCode("");
        setOauthDebugLog(`Upstox rejected this code as invalid or already used.\ncode=${trimmedCode}\nredirect_uri=${debugRedirectUri}\nNext step: tap Get Code, complete login again, and paste the brand-new code.`);
      }
      toast({ title: isInvalidCode ? "Fresh OAuth code required" : "OAuth exchange failed", description: message, variant: "destructive" });
    }
  };

  const fetchLiveNifty = async (executionIntent = false, skipReadyCheck = false) => {
    if (!skipReadyCheck && !upstoxReady) {
      throw new Error(systemStatus?.upstox?.message ?? "Complete Upstox OAuth from API Settings before fetching live market data.");
    }
    const market = await invokeFunction<{ data: NiftyData }>("fetch-nifty-data", { tradingLotSize: normalizedTradingLotSize, tradingQuantity: totalTradingQuantity, executionIntent });
    setLatestData(market.data);
    const value = Number(market.data?.ltp);
    if (Number.isFinite(value)) {
      const timestamp = market.data.source_timestamp ?? market.data.created_at ?? new Date().toISOString();
      setMarketHistory((prev) => [...prev, { value, time: timestamp }].slice(-30));
    }
    return market.data;
  };

  const checkSystemStatus = async (showToast = true) => {
    setIsCheckingStatus(true);
    try {
      const status = await invokeFunction<SystemStatus>("system-status");
      setSystemStatus(status);
      if (showToast) {
        const failures = [status.upstox, status.gemini].filter((item) => !item.ok).map((item) => item.message).join(" ");
        toast({
          title: status.ready ? "System ready for market open" : "Connection needs attention",
          description: status.ready ? "Upstox and OpenAI both verified successfully." : failures,
          variant: status.ready ? "default" : "destructive",
        });
      }
      return status;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to verify system status.";
      setSystemStatus(null);
      if (showToast) toast({ title: "System status failed", description: message, variant: "destructive" });
      throw error;
    } finally {
      setIsCheckingStatus(false);
    }
  };

  const retestUpstox = async (showToast = true) => {
    setIsCheckingStatus(true);
    try {
      const status = await invokeFunction<UpstoxStatus>("system-status", { target: "upstox" });
      setSystemStatus((prev) => {
        const gemini = prev?.gemini ?? { ok: false, message: "Run Re-test OpenAI to confirm OpenAI API status." };
        return { ready: status.upstox.ok && gemini.ok, upstox: status.upstox, gemini, checkedAt: status.checkedAt };
      });
      if (showToast) toast({ title: status.upstox.ok ? "Upstox verified" : "Upstox needs OAuth", description: status.upstox.message, variant: status.upstox.ok ? "default" : "destructive" });
      return status;
    } catch (error) {
      if (showToast) toast({ title: "Upstox re-test failed", description: error instanceof Error ? error.message : "Unable to test Upstox.", variant: "destructive" });
      throw error;
    } finally {
      setIsCheckingStatus(false);
    }
  };

  const retestOpenAI = async (showToast = true) => {
    setIsCheckingStatus(true);
    try {
      const status = await invokeFunction<OpenAIStatus>("system-status", { target: "openai" });
      setSystemStatus((prev) => {
        const upstox = prev?.upstox ?? { ok: false, message: "Run Verify Now to confirm Upstox API status." };
        return { ready: upstox.ok && status.gemini.ok, upstox, gemini: status.gemini, checkedAt: status.checkedAt };
      });
      if (showToast) toast({ title: status.gemini.ok ? "OpenAI connected" : "OpenAI still failing", description: status.gemini.message, variant: status.gemini.ok ? "default" : "destructive" });
      return status;
    } catch (error) {
      if (showToast) toast({ title: "OpenAI re-test failed", description: error instanceof Error ? error.message : "Unable to test OpenAI.", variant: "destructive" });
      throw error;
    } finally {
      setIsCheckingStatus(false);
    }
  };

  const runTradingCycle = async () => {
    if (tradingBlocked) return;
    if (!upstoxReady) {
      const status = await retestUpstox(true);
      if (!status.upstox.ok) return;
    }
    await fetchLiveNifty(false, true);
    const ai = await withTimeout(invokeFunction<{ signal: Signal }>("analyze-with-ai", { tradingLotSize: normalizedTradingLotSize, dailyProfitTarget: normalizedDailyTarget, maxDailyLoss: normalizedMaxDailyLoss, dailyPnl, userTargetPoints: Number(userTargetPoints) || null, userSlPoints: Number(userSlPoints) || null }), 25_000, "OpenAI analysis timed out; continuing Upstox polling.");
    setLatestSignal(ai.signal);
  };

  const executeTradingSignal = async () => {
    setIsBusy(true);
    try {
      if (!upstoxReady) {
        const status = await retestUpstox(true);
        if (!status.upstox.ok) return;
      }
      if (tradingBlocked) {
        toast({ title: cooldownActive ? "Cooldown Active" : targetAchieved ? "Target Achieved" : hardKillActive ? "Hard Kill-Switch Active" : "Max Trades Reached", description: cooldownActive ? `Next entry allowed in ${cooldownRemainingMinutes} min.` : "Trading activity is stopped for the day.", variant: targetAchieved || cooldownActive ? "default" : "destructive" });
        return;
      }
      const liveMarket = await fetchLiveNifty(true, true);
      const liveSpot = Number(liveMarket?.ltp);
      const ai = await withTimeout(invokeFunction<{ signal: Signal }>("analyze-with-ai", { tradingLotSize: normalizedTradingLotSize, executionIntent: true, dailyProfitTarget: normalizedDailyTarget, maxDailyLoss: normalizedMaxDailyLoss, dailyPnl, userTargetPoints: Number(userTargetPoints) || null, userSlPoints: Number(userSlPoints) || null }), 25_000, "OpenAI analysis timed out; execution cycle will retry.");
      setLatestSignal(ai.signal);
      if (ai.signal.action !== "WAIT") {
        if (!Number.isFinite(liveSpot)) {
          toast({ title: "Live price missing", description: "Cannot place a live order until Nifty spot is available.", variant: "destructive" });
          return;
        }
        const liveAvailableCash = toNumber(liveMarket?.raw_payload?.account?.margin?.availableCash) ?? availableCash;
        if (liveAvailableCash <= 0) {
          toast({ title: "Low Margin", description: "Available Cash from Upstox is zero or unavailable. Live order blocked.", variant: "destructive" });
          return;
        }
        const volatilityPoints = calculateVolatilityPoints(marketHistory);
        const targetPoints = Number(userTargetPoints) || volatilityPoints.targetPoints;
        const slPoints = Number(userSlPoints) || volatilityPoints.slPoints;
        const liveOrder = await invokeFunction<LiveOrderResult>("place-live-order", { action: ai.signal.action, spotPrice: liveSpot, tradingLotSize: normalizedTradingLotSize, effectiveLotSize: ai.signal.effectiveLotSize, targetPremiumPoints: targetPoints, stopLossPremiumPoints: slPoints });
        if (!liveOrder.success) {
          toast({ title: "Low Margin", description: "Available Cash is insufficient for the selected lot size. Live order blocked.", variant: "destructive" });
          return;
        }
        const plan: NonNullable<ActiveTradePlan> = { action: ai.signal.action as "BUY" | "SELL", entry: liveSpot, target: liveOrder.targetPremium, stopLoss: liveOrder.stopLossPremium, strike: liveOrder.instrument.tradingSymbol, quantity: liveOrder.quantity, initialTargetPoints: targetPoints, initialSlPoints: slPoints, instrumentToken: liveOrder.instrumentToken, slOrderId: liveOrder.slOrderId, entryPremium: liveOrder.entryPremium, currentPremium: liveOrder.entryPremium, targetPremium: liveOrder.targetPremium, stopLossPremium: liveOrder.stopLossPremium, lastSyncedStopLossPremium: liveOrder.stopLossPremium };
        setUserTargetPoints(String(targetPoints));
        setUserSlPoints(String(slPoints));
        const nextCount = Math.min(MAX_TRADES_PER_DAY, executedTrades + 1);
        setExecutedTrades(nextCount);
        setActiveTrade(true);
        setActiveTradePlan(plan);
        localStorage.setItem(TRADE_COUNT_STORAGE_KEY, `${todayKey()}:${nextCount}`);
        localStorage.setItem(ACTIVE_TRADE_STORAGE_KEY, `${todayKey()}:true`);
        localStorage.setItem(ACTIVE_TRADE_PLAN_STORAGE_KEY, `${todayKey()}:${JSON.stringify(plan)}`);
        toast({ title: "LIVE ORDER + SERVER SL PLACED", description: `${liveOrder.instrument.tradingSymbol} · Entry ₹${liveOrder.entryPremium.toFixed(2)} · SL ₹${liveOrder.stopLossPremium.toFixed(2)}.` });
        return;
      }
      toast({ title: "No live order", description: "AI returned WAIT, so no Upstox order was placed." });
    } catch (error) {
      showRetryToast(error instanceof Error ? error.message : "Execution cycle will retry on the next poll.");
    } finally {
      setIsBusy(false);
    }
  };

  const emergencyExit = async (lockForDay = false) => {
    setIsBusy(true);
    try {
      await invokeFunction("emergency-exit", { lockForDay, slOrderId: activeTradePlan?.slOrderId });
      const nextCooldown = Date.now() + COOLDOWN_MS;
      setActiveTrade(false);
      setActiveTradePlan(null);
      setCooldownUntil(nextCooldown);
      localStorage.setItem(ACTIVE_TRADE_STORAGE_KEY, `${todayKey()}:false`);
      localStorage.removeItem(ACTIVE_TRADE_PLAN_STORAGE_KEY);
      localStorage.setItem(COOLDOWN_UNTIL_STORAGE_KEY, String(nextCooldown));
      if (lockForDay) {
        const today = todayKey();
        setKillSwitchDate(today);
        setAiEnabled(false);
        localStorage.setItem(KILL_SWITCH_STORAGE_KEY, today);
        localStorage.setItem(AI_ARMED_STORAGE_KEY, "false");
      }
      toast({ title: lockForDay ? "Emergency exit + lock active" : "Emergency exit sent", description: "Open positions exit request was sent to Upstox. New entries are blocked for 15 minutes." });
    } catch (error) {
      toast({ title: "Emergency exit failed", description: error instanceof Error ? error.message : "Please check Upstox and retry.", variant: "destructive" });
    } finally {
      setIsBusy(false);
    }
  };

  const toggleAiTrading = async (checked: boolean) => {
    if (checked && tradingBlocked) {
      toast({ title: cooldownActive ? "Cooldown Active" : targetAchieved ? "Target Achieved" : hardKillActive ? "Hard Kill-Switch Active" : "Max Trades Reached", description: cooldownActive ? `AI entry blocked for ${cooldownRemainingMinutes} more minutes.` : "AI trading is disabled for the rest of the day.", variant: targetAchieved || cooldownActive ? "default" : "destructive" });
      return;
    }
    setIsBusy(true);
    localStorage.setItem(AI_ARMED_STORAGE_KEY, String(checked));
    try {
      await invokeFunction("toggle-ai-trading", { isActive: checked, riskMode, tradingLotSize: normalizedTradingLotSize, tradingQuantity: totalTradingQuantity });
      setAiEnabled(checked);
      if (checked) {
        const status = await retestUpstox(false);
        if (!status.upstox.ok) {
          setAiEnabled(false);
          localStorage.setItem(AI_ARMED_STORAGE_KEY, "false");
          toast({ title: "Upstox OAuth required", description: status.upstox.message, variant: "destructive" });
          return;
        }
        await fetchLiveNifty(false, true);
      }
      toast({ title: checked ? "AI trading loop started" : "AI trading loop stopped", description: checked ? "Upstox prices refresh every 5 seconds; OpenAI reasoning runs every 30 seconds while this page is open." : "Automation is paused." });
    } catch (error) {
      if (checked) setAiEnabled(true);
      showRetryToast(error instanceof Error ? error.message : "Check credentials and OAuth status.");
    } finally {
      setIsBusy(false);
    }
  };

  useEffect(() => {
    if (marketIntervalRef.current) clearInterval(marketIntervalRef.current);
    if (aiIntervalRef.current) clearInterval(aiIntervalRef.current);
    if (session && upstoxReady) {
      marketIntervalRef.current = setInterval(() => {
        fetchLiveNifty().catch((error) => showRetryToast(error instanceof Error ? error.message : "Unable to fetch Upstox market data."));
      }, UPSTOX_POLL_INTERVAL_MS);
      if (aiEnabled) {
        aiIntervalRef.current = setInterval(() => {
          if (tradingBlocked) return;
          withTimeout(invokeFunction<{ signal: Signal }>("analyze-with-ai", { tradingLotSize: normalizedTradingLotSize, dailyProfitTarget: normalizedDailyTarget, maxDailyLoss: normalizedMaxDailyLoss, dailyPnl, userTargetPoints: Number(userTargetPoints) || null, userSlPoints: Number(userSlPoints) || null }), 25_000, "OpenAI analysis timed out; continuing Upstox polling.")
            .then((ai) => setLatestSignal(ai.signal))
            .catch((error) => showRetryToast(error instanceof Error ? error.message : "OpenAI reasoning will retry on the next 30-second poll."));
        }, AI_REASONING_INTERVAL_MS);
      }
    }
    return () => {
      if (marketIntervalRef.current) clearInterval(marketIntervalRef.current);
      if (aiIntervalRef.current) clearInterval(aiIntervalRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, upstoxReady, aiEnabled, normalizedTradingLotSize, totalTradingQuantity, tradingBlocked, normalizedDailyTarget, normalizedMaxDailyLoss, dailyPnl, userTargetPoints, userSlPoints]);

  useEffect(() => {
    if (!session) return;
    checkSystemStatus(false).then((status) => {
      if (status.upstox.ok) return fetchLiveNifty(false, true);
      return null;
    }).catch(() => {
      // Connection Pulse will show missing setup after a manual check.
    });
    if (aiEnabled && !marketIsOpen) setAiEnabled(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  return (
    <main className={`min-h-screen overflow-hidden bg-terminal text-foreground ${exitAlertActive ? "animate-pulse bg-loss" : ""}`}>
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
                <span className="text-2xl font-bold text-foreground">{hasLivePrice ? latestLtp.toLocaleString("en-IN") : "—"}</span>
                <span className="flex items-center text-sm font-semibold text-profit"><TrendingUp className="h-4 w-4" /> {hasLivePrice ? "Live" : "Waiting"}</span>
              </div>
            </div>
            <div className="rounded-md border border-primary/30 bg-primary/10 px-4 py-3">
              <p className="text-xs uppercase text-muted-foreground">Connection Status</p>
              <div className={`mt-2 flex items-center gap-2 text-sm font-semibold ${connectionTone}`}>
                <span className={`h-2.5 w-2.5 rounded-full ${connectionDot} animate-pulse-glow`} /> {connectionLabel}
              </div>
            </div>
              <div className="rounded-md border border-border bg-surface px-4 py-3">
                <p className="text-xs uppercase text-muted-foreground">Available Cash</p>
                <p className="mt-1 text-2xl font-bold text-profit">{formatMoney(latestData?.raw_payload?.account?.margin?.availableCash)}</p>
              </div>
              <div className="rounded-md border border-border bg-surface px-4 py-3">
                <p className="text-xs uppercase text-muted-foreground">Today's P&L</p>
                <p className={`mt-1 text-2xl font-bold ${dailyPnl >= 0 ? "text-profit" : "text-loss"}`}>{formatMoney(dailyPnl)}</p>
              </div>
          </div>
          {session && (
            <Button type="button" variant="terminal" className="md:w-auto" onClick={() => setSettingsOpen(true)}>
              <Settings className="h-4 w-4" /> API Settings
            </Button>
          )}
        </header>

        {!session && (
          <section className="rounded-lg border border-border bg-panel p-5 shadow-panel">
            <div className="mb-4 flex items-center gap-2"><LogIn className="h-5 w-5 text-primary" /><h2 className="text-xl font-semibold">Secure Access</h2></div>
            <form onSubmit={signIn} className="grid gap-3 md:grid-cols-[1fr_1fr_auto_auto]">
              <Input type="email" placeholder="Email" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} required className="border-border bg-surface" />
              <Input type="password" placeholder="Password" value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} required minLength={8} className="border-border bg-surface" />
              <Button type="submit" variant="trading">Sign in</Button>
              <Button type="button" variant="terminal" onClick={signInWithGoogle}>Google</Button>
            </form>
          </section>
        )}

        <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
          <DialogContent className="h-dvh w-screen max-w-none overflow-y-auto rounded-none border-border bg-panel text-foreground shadow-panel sm:h-auto sm:max-h-[92vh] sm:max-w-2xl sm:rounded-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-xl"><KeyRound className="h-5 w-5 text-primary" /> API Settings</DialogTitle>
              <DialogDescription>Keys are submitted only to the secure backend function and are cleared from this form after saving.</DialogDescription>
            </DialogHeader>
            <form onSubmit={saveOpenAISettings} className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="upstox-api-key" className="flex items-center gap-2">Upstox API Key {systemStatus?.upstox?.ok && <CheckCircle2 className="h-4 w-4 text-profit" aria-label="Upstox verified" />}</Label>
                  <Input id="upstox-api-key" type="text" autoComplete="off" placeholder="Enter Upstox API Key" value={settings.upstoxApiKey} onChange={(event) => setSettings((prev) => ({ ...prev, upstoxApiKey: event.target.value }))} className="border-border bg-surface" />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="upstox-api-secret" className="flex items-center gap-2">Upstox API Secret {systemStatus?.upstox?.ok && <CheckCircle2 className="h-4 w-4 text-profit" aria-label="Upstox verified" />}</Label>
                  <Input id="upstox-api-secret" type="text" autoComplete="off" placeholder="Enter Upstox API Secret" value={settings.upstoxApiSecret} onChange={(event) => setSettings((prev) => ({ ...prev, upstoxApiSecret: event.target.value }))} className="border-border bg-surface" />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="openai-api-key" className="flex items-center gap-2">OpenAI API Key {systemStatus?.gemini?.ok && <CheckCircle2 className="h-4 w-4 text-profit" aria-label="OpenAI verified" />}</Label>
                  <Input id="openai-api-key" type="text" autoComplete="off" placeholder="Enter OpenAI API Key" value={settings.openaiApiKey} onChange={(event) => setSettings((prev) => ({ ...prev, openaiApiKey: event.target.value }))} className="border-border bg-surface" />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="redirect-uri">Manual Redirect URI from Upstox Developer Portal</Label>
                  <Input id="redirect-uri" type="url" autoComplete="off" value={settings.redirectUri} readOnly className="border-border bg-surface" />
                  <p className="text-xs leading-5 text-muted-foreground">Get Code and Connect both use this exact value. In the Authorization URL it is encoded as <span className="text-foreground">redirect_uri={encodeURIComponent(UPSTOX_OAUTH_REDIRECT_URI)}</span>.</p>
                </div>
              </div>
              <DialogFooter className="gap-2 sm:justify-between sm:space-x-0">
                <Button disabled={isBusy} type="button" variant="terminal" onClick={startUpstoxOAuth}><ExternalLink className="h-4 w-4" /> Get Code</Button>
                <Button disabled={isBusy || !settings.upstoxApiKey || !settings.upstoxApiSecret} type="button" variant="terminal" onClick={saveUpstoxSettings}>Save Upstox</Button>
                <Button disabled={isBusy || !settings.openaiApiKey} type="submit" variant="trading">Save OpenAI</Button>
              </DialogFooter>
            </form>
            <div className="rounded-md border border-border bg-surface p-3">
              <Label htmlFor="authorization-url" className="text-muted-foreground">Authorization URL generated right now</Label>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">This is the exact full link returned by the secure backend. Tap Get Code to refresh it, then finish login and copy the <span className="font-semibold text-foreground">code</span> from the redirected URL bar.</p>
              <Textarea id="authorization-url" readOnly value={authorizationUrl || "Tap Get Code to generate the full Upstox Authorization URL."} className="mt-2 min-h-[120px] resize-none break-all border-border bg-panel font-mono text-xs" />
            </div>
            <div className="rounded-md border border-border bg-surface p-3">
              <Label htmlFor="oauth-code" className="text-muted-foreground">Upstox OAuth code</Label>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">Tap Get Code, finish Upstox login, then copy a fresh <span className="font-semibold text-foreground">code</span> value from the redirected URL bar and paste it here.</p>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <Input id="oauth-code" placeholder="Paste OAuth code" value={oauthCode} onChange={(event) => setOauthCode(event.target.value)} className="border-border bg-panel" />
                <Button disabled={!oauthCode || isBusy} type="button" variant="terminal" onClick={completeUpstoxOAuth}>Connect</Button>
              </div>
            </div>
            <div className="rounded-md border border-border bg-surface p-3">
              <Label htmlFor="oauth-debug-log" className="text-muted-foreground">Debug Log</Label>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">This shows the exact token exchange payload. Generate a fresh OAuth code before tapping Connect again.</p>
              <Textarea id="oauth-debug-log" readOnly value={oauthDebugLog} className="mt-2 min-h-[96px] resize-none border-border bg-panel font-mono text-xs" />
            </div>
          </DialogContent>
        </Dialog>

        {session && (
          <section className="rounded-lg border border-border bg-panel p-5 shadow-panel">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div><p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Connection Pulse</p><h2 className="text-xl font-semibold">System Status</h2></div>
              <Button type="button" variant="terminal" disabled={isCheckingStatus} onClick={() => checkSystemStatus(true)}>
                <RefreshCw className={`h-4 w-4 ${isCheckingStatus ? "animate-spin" : ""}`} /> Verify Now
              </Button>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className={`rounded-md border p-4 ${systemStatus?.upstox?.ok ? "border-profit/30 bg-profit/10" : "border-border bg-surface"}`}>
                <div className="mb-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2 font-semibold">
                    {systemStatus?.upstox?.ok ? <CheckCircle2 className="h-5 w-5 text-profit" /> : <XCircle className="h-5 w-5 text-loss" />}
                    <span>Upstox API Status</span>
                  </div>
                  <Button type="button" variant="terminal" size="sm" disabled={isCheckingStatus} onClick={() => retestUpstox()}>
                    <RefreshCw className={`h-4 w-4 ${isCheckingStatus ? "animate-spin" : ""}`} /> Re-test Upstox
                  </Button>
                </div>
                <p className="text-sm leading-6 text-muted-foreground">{systemStatus?.upstox?.message ?? "Confirms the OAuth access token can reach Upstox right now."}</p>
              </div>
              <div className={`rounded-md border p-4 ${systemStatus?.gemini?.ok ? "border-profit/30 bg-profit/10" : "border-border bg-surface"}`}>
                <div className="mb-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2 font-semibold">
                    {systemStatus?.gemini?.ok ? <CheckCircle2 className="h-5 w-5 text-profit" /> : <XCircle className="h-5 w-5 text-loss" />}
                    <span>OpenAI GPT-4o Status</span>
                  </div>
                  <Button type="button" variant="terminal" size="sm" disabled={isCheckingStatus} onClick={() => retestOpenAI()}>
                    <RefreshCw className={`h-4 w-4 ${isCheckingStatus ? "animate-spin" : ""}`} /> Re-test OpenAI
                  </Button>
                </div>
                <p className="text-sm leading-6 text-muted-foreground">{systemStatus?.gemini?.message ?? "Runs a small OpenAI GPT-4o response test using the saved key."}</p>
              </div>
            </div>
            {systemStatus?.checkedAt && <p className="mt-3 text-xs text-muted-foreground">Last checked: {new Date(systemStatus.checkedAt).toLocaleString("en-IN")}</p>}
          </section>
        )}

        <div className="grid gap-5 xl:grid-cols-[1.55fr_0.85fr]">
          <section className="relative min-h-[430px] overflow-hidden rounded-lg border border-border bg-panel shadow-panel">
            <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center sm:justify-between">
              <div><p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Real-time Upstox feed</p><h2 className="text-xl font-semibold">NIFTY 50 · 1m Live Price</h2></div>
              <div className="flex flex-wrap gap-2 text-xs font-semibold"><span className="rounded-sm border border-profit/30 bg-profit/10 px-2 py-1 text-profit">{latestSignal?.action ?? "WAIT"} Bias</span><span className="rounded-sm border border-border bg-surface px-2 py-1 text-muted-foreground">Vol: {latestSignal?.ruleContext?.rules?.volumeValid === true ? "Valid +20%" : latestSignal?.ruleContext?.rules?.volumeValid === false ? "Below +20%" : "Pending"}</span><span className="rounded-sm border border-border bg-surface px-2 py-1 text-muted-foreground">VIX: {latestData?.raw_payload?.context?.indiaVix?.ltp ?? "—"}</span></div>
            </div>
            <div className="market-grid relative h-[360px] p-5">
              <div className="absolute inset-y-5 right-5 flex flex-col justify-between text-xs text-muted-foreground">{chartLevels.map((level, index) => <span key={`${level}-${index}`}>{marketHistory.length ? level.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : "—"}</span>)}</div>
              <div className="absolute left-0 top-1/2 h-px w-full bg-profit/40" />
              <div className="absolute left-0 top-0 h-full w-1/3 bg-gradient-to-r from-primary/10 to-transparent animate-scan motion-reduce:animate-none" />
              {marketHistory.length ? <div className="absolute bottom-8 left-5 right-14 flex h-64 items-end gap-2">{chartBars.map((height, index) => <div key={`${marketHistory[index].time}-${index}`} className="flex flex-1 items-end justify-center"><span className={`w-full max-w-3 rounded-t-sm ${index > 0 && marketHistory[index].value < marketHistory[index - 1].value ? "bg-loss" : "bg-profit"}`} style={{ height: `${height}%` }} /></div>)}</div> : <div className="absolute inset-x-5 bottom-8 right-14 flex h-64 items-center justify-center rounded-md border border-border bg-surface/70 text-sm text-muted-foreground">Connect Upstox OAuth to stream live Nifty 50 prices.</div>}
              {chartPolyline && <svg className="absolute bottom-8 left-5 right-14 h-64 w-[calc(100%-5.75rem)] overflow-visible" preserveAspectRatio="none" viewBox="0 0 100 100" aria-hidden="true"><polyline points={chartPolyline} fill="none" stroke="hsl(var(--chart-line))" strokeWidth="1.8" vectorEffect="non-scaling-stroke" /></svg>}
            </div>
          </section>

          <aside className="grid gap-5">
            <section className="rounded-lg border border-border bg-panel p-5 shadow-panel">
              <div className="mb-5 flex items-center justify-between"><div><p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">AI Control Panel</p><h2 className="text-xl font-semibold">Autonomy Settings</h2></div><Bot className="h-6 w-6 text-primary" /></div>
              <div className="space-y-5">
                {upstoxNeedsSetup && <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm font-semibold text-warning">Upstox OAuth is not connected. Open API Settings, tap Get Code, then Connect before starting live data or orders.</div>}
                <div className="flex items-center justify-between rounded-md border border-border bg-surface p-4"><div><p className="font-semibold">Start AI Trading</p><p className="text-sm text-muted-foreground">Trades Remaining: {tradesRemaining}/4</p></div><Switch disabled={!session || isBusy || tradingBlocked || !upstoxReady} checked={aiEnabled} onCheckedChange={toggleAiTrading} aria-label="Start AI Trading" /></div>
                <div className="space-y-2"><Label htmlFor="trading-lot-size" className="text-sm font-medium text-muted-foreground">Trading Lot Size</Label><Input id="trading-lot-size" type="number" min="1" step="1" inputMode="numeric" value={tradingLotSize} onChange={(event) => setTradingLotSize(event.target.value)} className="border-border bg-surface" /><p className="text-xs text-muted-foreground">Total quantity sent to Upstox: {totalTradingQuantity}</p></div>
                {latestSignal?.riskSizeDown && <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm font-semibold text-warning">Risk size-down active for this trade: quantity reduced to {suggestedQuantity}.</div>}
                <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor="user-target-points" className="text-sm font-medium text-muted-foreground">Premium Target Points</Label><Input id="user-target-points" type="number" min="0" step="1" inputMode="numeric" value={userTargetPoints} onChange={(event) => handleTargetPointsChange(event.target.value)} className="border-border bg-surface" /></div><div className="space-y-2"><Label htmlFor="user-sl-points" className="text-sm font-medium text-muted-foreground">Premium SL / TSL Points</Label><Input id="user-sl-points" type="number" min="0" step="1" inputMode="numeric" value={userSlPoints} onChange={(event) => handleSlPointsChange(event.target.value)} className="border-border bg-surface" /></div></div>
                <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor="daily-profit-target" className="text-sm font-medium text-muted-foreground">Daily Profit Target</Label><Input id="daily-profit-target" type="number" min="0" step="500" inputMode="numeric" value={dailyProfitTarget} onChange={(event) => setDailyProfitTarget(event.target.value)} className="border-border bg-surface" /></div><div className="rounded-md border border-loss/30 bg-loss/10 p-3"><p className="text-xs text-muted-foreground">Daily Max Loss</p><p className="text-lg font-bold text-loss">₹{DAILY_STOP_LOSS.toLocaleString("en-IN")}</p></div></div>
                {(targetAchieved || hardKillActive || cooldownActive) && <div className={`rounded-md border p-3 text-sm font-semibold ${targetAchieved || cooldownActive ? "border-profit/30 bg-profit/10 text-profit" : "border-loss/30 bg-loss/10 text-loss"}`}>{cooldownActive ? `Cooldown Active — next entry in ${cooldownRemainingMinutes} min.` : targetAchieved ? "Target Achieved — AI trading stopped for the day." : "Hard Kill-Switch Active — max daily loss hit."}</div>}
                <div className="space-y-2"><label className="text-sm font-medium text-muted-foreground">Risk Mode</label><Select value={riskMode} onValueChange={setRiskMode}><SelectTrigger className="border-border bg-surface text-foreground"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="conservative">Conservative</SelectItem><SelectItem value="moderate">Moderate</SelectItem><SelectItem value="aggressive">Aggressive</SelectItem></SelectContent></Select></div>
                <Button disabled={!session || isBusy || tradingBlocked || !upstoxReady} variant={aiEnabled ? "terminal" : "trading"} className="w-full" onClick={() => toggleAiTrading(!aiEnabled)}>{aiEnabled ? "Armed" : "Arm AI Trading"}</Button>
                <Button disabled={!session || isBusy || ((tradingBlocked || !upstoxReady) && !activeTrade)} variant={activeTrade ? "destructive" : "terminal"} className={`w-full ${activeTrade ? "min-h-20 animate-pulse text-2xl font-black" : ""}`} onClick={() => activeTrade ? emergencyExit(false) : executeTradingSignal()}>{activeTrade ? "BIG RED EXIT ALL" : "Execute Live Order"}</Button>
                {activeTradePlan && <div className={`rounded-md border p-3 ${exitAlertActive ? "border-loss bg-loss text-foreground" : "border-profit/30 bg-profit/10 text-profit"}`}><div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><span className="text-sm font-semibold">{exitAlertActive ? (activeTradePlan.exitAlertReason === "FINAL_TARGET" ? "FINAL TARGET HIT — EXIT NOW" : "TRAILING SL HIT — EXIT NOW") : `Live: ${activeTradePlan.strike} · ${activeTradePlan.quantity} qty`}</span><div className="text-left sm:text-right"><p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Current Profit/Loss</p><span className={`text-3xl font-black ${currentTradePnlMoney >= 0 ? "text-profit" : "text-loss"}`}>{formatMoney(currentTradePnlMoney)}</span></div></div><p className="mt-2 text-xs font-semibold text-muted-foreground">Premium ₹{activeTradePlan.currentPremium?.toFixed(2) ?? activeTradePlan.entryPremium?.toFixed(2) ?? "—"} · Target ₹{(activeTradePlan.targetPremium ?? activeTradePlan.target).toFixed(2)} / Server TSL ₹{(activeTradePlan.stopLossPremium ?? activeTradePlan.stopLoss).toFixed(2)} · P/L ₹{currentTradePnlPoints.toFixed(2)}</p></div>}
              </div>
            </section>

            <section className={`rounded-lg border bg-panel p-5 shadow-market ${aiPanelTone}`}><div className="mb-3 flex items-center gap-2 text-primary"><Activity className="h-5 w-5" /><h2 className="text-lg font-semibold text-foreground">Live AI Reasoning</h2></div><p className={`min-h-20 rounded-md border bg-surface p-4 text-sm leading-6 ${aiTextTone}`}>{reasoning}</p><div className="mt-4 grid gap-3 sm:grid-cols-2"><div className="rounded-md border border-border bg-surface p-3"><div className="mb-2 flex items-center justify-between text-sm"><span className="font-semibold text-muted-foreground">PCR</span><span className="font-bold text-foreground">{pcrValue === null ? "—" : pcrValue.toFixed(3)}</span></div><Progress value={clampMeter(pcrValue, 2)} className="h-2" /><p className="mt-2 text-xs text-muted-foreground">{latestSignal?.ruleContext?.rules?.pcrState ?? "Pending"}</p></div><div className="rounded-md border border-border bg-surface p-3"><div className="mb-2 flex items-center justify-between text-sm"><span className="font-semibold text-muted-foreground">India VIX</span><span className="font-bold text-foreground">{vixValue === null ? "—" : vixValue.toFixed(2)}</span></div><Progress value={clampMeter(vixValue, 30)} className="h-2" /><p className="mt-2 text-xs text-muted-foreground">{latestSignal?.ruleContext?.rules?.vixSizeCut ? "Size -50%" : latestSignal?.ruleContext?.rules?.vixRising ? "Rising" : "Normal"}</p></div></div></section>
          </aside>
        </div>

        <div className="grid gap-5 lg:grid-cols-[1.35fr_0.65fr]">
          <section className="overflow-hidden rounded-lg border border-border bg-panel shadow-panel">
            <div className="flex items-center gap-2 border-b border-border p-4"><SlidersHorizontal className="h-5 w-5 text-accent" /><h2 className="text-xl font-semibold">Trade History</h2></div>
            <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-left text-sm"><thead className="bg-surface text-xs uppercase text-muted-foreground"><tr>{["Time", "Instrument", "Entry Price", "Exit Price", "P&L"].map((head) => <th key={head} className="px-4 py-3 font-semibold">{head}</th>)}</tr></thead><tbody>{history.map((trade) => <tr key={`${trade.time}-${trade.instrument}`} className="border-t border-border transition-colors hover:bg-surface/70"><td className="px-4 py-4 text-muted-foreground">{trade.time}</td><td className="px-4 py-4 font-semibold">{trade.instrument}</td><td className="px-4 py-4">{trade.entry}</td><td className="px-4 py-4">{trade.exit}</td><td className={`px-4 py-4 font-bold ${trade.result === "profit" ? "text-profit" : "text-loss"}`}>{trade.pnl}</td></tr>)}</tbody></table></div>
          </section>

          <section className="rounded-lg border border-border bg-panel p-5 shadow-panel">
            <div className="mb-5 flex items-center justify-between"><div><p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Daily Limit</p><h2 className="text-xl font-semibold">Risk Guardrails</h2></div><ShieldCheck className="h-6 w-6 text-primary" /></div>
            <div className="space-y-5"><div className="rounded-md border border-border bg-surface p-3"><p className="text-xs text-muted-foreground">Max Trades</p><p className="mt-1 text-sm font-semibold text-foreground">Trades Remaining: {tradesRemaining}/4</p></div><div className="rounded-md border border-loss/30 bg-loss/10 p-3"><p className="text-xs text-muted-foreground">Daily Max Loss</p><p className="mt-1 text-sm font-semibold text-loss">Hard lock at -₹{DAILY_STOP_LOSS.toLocaleString("en-IN")}</p></div><div className="rounded-md border border-border bg-surface p-3"><p className="text-xs text-muted-foreground">Premium Server TSL</p><p className="mt-1 text-sm font-semibold text-foreground">Server SL-M is placed immediately and modified every ₹5 favorable premium move.</p></div><div className="grid grid-cols-2 gap-3"><div className="rounded-md border border-border bg-surface p-3"><Gauge className="mb-2 h-5 w-5 text-warning" /><p className="text-xs text-muted-foreground">Used Today</p><p className="font-bold">{executedTrades} / {MAX_TRADES_PER_DAY}</p></div><div className={`rounded-md border bg-surface p-3 ${tradingBlocked ? "border-loss/40" : "border-border"}`}><IndianRupee className="mb-2 h-5 w-5 text-loss" /><p className="text-xs text-muted-foreground">Today's P&L</p><p className={`font-bold ${dailyPnl >= 0 ? "text-profit" : "text-loss"}`}>₹{dailyPnl.toLocaleString("en-IN")}</p></div></div></div>
          </section>
        </div>
      </section>
    </main>
  );
};

export default Index;
