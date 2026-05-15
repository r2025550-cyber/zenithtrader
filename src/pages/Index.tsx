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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  {
    time: "09:31:22",
    instrument: "Nifty 22500 CE",
    entry: "₹132.40",
    exit: "₹148.10",
    pnl: "+₹7,850",
    result: "profit",
  },
  { time: "10:08:47", instrument: "Nifty 22400 PE", entry: "₹96.75", exit: "₹90.20", pnl: "-₹3,275", result: "loss" },
  { time: "11:42:03", instrument: "Nifty 22600 CE", entry: "₹78.15", exit: "₹85.65", pnl: "+₹3,750", result: "profit" },
  { time: "13:15:38", instrument: "Nifty 22550 PE", entry: "₹112.90", exit: "Open", pnl: "+₹1,125", result: "profit" },
];

const DEFAULT_FASTAPI_BASE_URL = "https://size-exams-mono-skill.trycloudflare.com";
const VPS_TUNNEL_URL_STORAGE_KEY = "zenith-vps-tunnel-url";
const UPSTOX_CLIENT_ID_STORAGE_KEY = "zenith-upstox-client-id";
const VPS_STATUS_ENDPOINT_STORAGE_KEY = "zenith-vps-status-endpoint";
const DEFAULT_VPS_STATUS_ENDPOINT = "/";
const normalizeStatusEndpoint = (raw?: string) => {
  const v = (raw || DEFAULT_VPS_STATUS_ENDPOINT).trim();
  if (!v) return DEFAULT_VPS_STATUS_ENDPOINT;
  return v.startsWith("/") ? v : `/${v}`;
};
const normalizeSavedStatusEndpoint = (raw?: string) => {
  const endpoint = normalizeStatusEndpoint(raw);
  return endpoint === "/system-status" ? DEFAULT_VPS_STATUS_ENDPOINT : endpoint;
};
const getStatusEndpointMethod = (endpoint: string) => (endpoint === "/" || endpoint === "/fetch-data" ? "GET" : "POST");
// Use the VPS Tunnel URL exactly as the user typed it — only trim whitespace and
// trailing slashes. Do NOT auto-append /callback or any other suffix here.
const getVpsBaseUrl = (value?: string) => (value || DEFAULT_FASTAPI_BASE_URL).trim().replace(/\/+$/, "");
// Build the Upstox redirect URI by appending exactly ONE /callback to the base
// VPS URL. If the user already included /callback in the base, do not duplicate it.
const getUpstoxRedirectUri = (baseUrl: string) => {
  const base = getVpsBaseUrl(baseUrl);
  return /\/callback$/i.test(base) ? base : `${base}/callback`;
};

async function syncFastApiMode(target: "auto" | "manual", baseUrl = DEFAULT_FASTAPI_BASE_URL): Promise<{ status: string; mode: string }> {
  const apiBase = getVpsBaseUrl(baseUrl);
  const res = await fetch(`${apiBase}/mode/${target}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Backend ${res.status}`);
  const statusRes = await fetch(`${apiBase}/status`, { headers: { Accept: "application/json", "Content-Type": "application/json" } });
  if (!statusRes.ok) throw new Error(`Backend status ${statusRes.status}`);
  const data = await statusRes.json().catch(() => ({}));
  return { status: String(data?.status ?? "UNKNOWN"), mode: String(data?.mode ?? target.toUpperCase()) };
}
const UPSTOX_INVALID_CODE_ERROR = "UDAPI100057";
const UPSTOX_INVALID_TOKEN_ERROR = "UDAPI100050";
const UPSTOX_RATE_LIMIT_ERROR = "UDAPI10005";
const AI_ARMED_STORAGE_KEY = "zenith-ai-trading-armed";
const AUTO_TRADE_STORAGE_KEY = "zenith-auto-trade-mode";
const UPSTOX_CONNECTED_FLAG_KEY = "zenith-upstox-connected";
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
const UPSTOX_RATE_LIMIT_BACKOFF_MS = 5_000;
const AI_REASONING_INTERVAL_MS = 60_000;
// Force fresh AI analysis when spot drifts >50pts from anchor (per spec).
const AI_SPOT_DRIFT_TRIGGER_PTS = 50;
// Treat cached S/R as stale when level is implausibly far from current spot.
const SR_STALE_DISTANCE_PTS = 200;
const NIFTY_LOT_SIZE = 65;
const MAX_TRADES_PER_DAY = 4;
const DAILY_STOP_LOSS = 2000;
const DEFAULT_PREMIUM_TARGET_POINTS = 25;
const DEFAULT_PREMIUM_SL_POINTS = 15;
const PREMIUM_TSL_STEP = 3; // v7-aggressive: trail every +3pts (was 5)
const COOLDOWN_MS = 5 * 60 * 1000; // v7-aggressive: 5min cooldown (was 15)
const SIGNAL_LOCK_MS = 20_000;
const SIGNAL_STALE_MS = 30_000;

const getIndiaMarketMinute = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
};

const isWithinMarketHours = (date = new Date()) => {
  const minute = getIndiaMarketMinute(date);
  return minute >= MARKET_OPEN_MINUTE && minute <= MARKET_CLOSE_MINUTE;
};

const storedValue = (key: string, fallback = "") =>
  typeof window === "undefined" ? fallback : (localStorage.getItem(key) ?? fallback);
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
const clampMeter = (value: number | null, max: number) =>
  value === null ? 0 : Math.min(100, Math.max(0, (value / max) * 100));
const parseSuggestedStrike = (strike?: string) => {
  const match = strike?.match(/Nifty\s+(\d{4,6})\s+(CE|PE)/i);
  return match ? Number(match[1]) : null;
};
const parseSuggestedAction = (signal?: Signal | null) => {
  if (signal?.action === "BUY" || signal?.action === "SELL") return signal.action;
  const optionType = signal?.strike?.match(/Nifty\s+\d{4,6}\s+(CE|PE)/i)?.[1]?.toUpperCase();
  return optionType === "CE" ? "BUY" : optionType === "PE" ? "SELL" : null;
};
const calculatePremiumExitPrices = (entryPremium: number, slPointsOverride?: number, targetPointsOverride?: number) => {
  const slPts =
    Number.isFinite(slPointsOverride) && (slPointsOverride as number) > 0
      ? (slPointsOverride as number)
      : DEFAULT_PREMIUM_SL_POINTS;
  const tgtPts =
    Number.isFinite(targetPointsOverride) && (targetPointsOverride as number) > 0
      ? (targetPointsOverride as number)
      : Math.max(DEFAULT_PREMIUM_TARGET_POINTS, slPts * 2);
  return {
    targetPremium: Number((entryPremium + tgtPts).toFixed(2)),
    stopLossPremium: Number(Math.max(0.05, entryPremium - slPts).toFixed(2)),
  };
};
const formatPremiumInput = (value: number) => String(Number(value.toFixed(2)));
const isTradeSignal = (action?: string | null) => action === "BUY" || action === "SELL";

type RuleContext = {
  rules?: {
    volumeValid?: boolean | null;
    fakeBreakout?: boolean;
    vixRising?: boolean;
    vixMovePct?: number | null;
    vixSizeCut?: boolean;
    vixStable?: boolean;
    europeanOpenCaution?: boolean;
    overextended?: boolean;
    noTradeRange?: boolean;
    divergence?: boolean;
    pcr?: number | null;
    pcrState?: string;
    emaAligned?: boolean;
    emaTrend?: string;
    priceAboveEma21?: boolean;
    priceBelowEma21?: boolean;
    sustainedBullish1m?: boolean;
    sustainedBearish1m?: boolean;
    multiTimeframeAligned?: boolean;
    trend5?: string;
    entry1m?: string;
  };
};
type Signal = {
  action: string;
  strike: string;
  reason: string;
  conviction?: "HIGH" | "MEDIUM" | "LOW";
  highProbability?: boolean;
  ruleContext?: RuleContext;
  created_at?: string;
  tradingLotSize?: number;
  effectiveLotSize?: number;
  effectiveTradingQuantity?: number;
  riskSizeDown?: boolean;
};
type NiftyData = {
  ltp?: number | string | null;
  open_price?: number | string | null;
  high_price?: number | string | null;
  low_price?: number | string | null;
  close_price?: number | string | null;
  raw_payload?: {
    volume?: number | string | null;
    optionChain?: { pcr?: number | string | null };
    account?: {
      margin?: { availableCash?: number | string | null; usedMargin?: number | string | null };
      todayPnl?: number | string | null;
    };
    context?: {
      indiaVix?: { ltp?: number | string | null };
      bankNifty?: { ltp?: number | string | null };
      heavyweights?: Array<{ ltp?: number | string | null }>;
      yesterday?: {
        pdh?: number | null;
        pdl?: number | null;
        pdc?: number | null;
        pdo?: number | null;
        date?: string | null;
      };
      atm?: {
        strike?: number | null;
        expiry?: string | null;
        ce?: { instrumentToken?: string; tradingSymbol?: string; strike?: number; ltp?: number | null } | null;
        pe?: { instrumentToken?: string; tradingSymbol?: string; strike?: number; ltp?: number | null } | null;
      };
    };
  };
  created_at?: string;
  source_timestamp?: string;
};
type MarketPoint = { value: number; time: string };
type PulseCheck = { ok: boolean; message: string; details?: Record<string, unknown> };
type SystemStatus = { ready: boolean; upstox: PulseCheck; gemini: PulseCheck; checkedAt: string };
type OpenAIStatus = { gemini: PulseCheck; checkedAt: string };
type UpstoxStatus = { upstox: PulseCheck; checkedAt: string };
type MarketFetchResult = {
  data: NiftyData | null;
  fallback?: boolean;
  rateLimited?: boolean;
  retryAfterMs?: number;
  error?: string;
  details?: string;
};
type ActiveTradePlan = {
  action: "BUY" | "SELL";
  entry: number;
  target: number;
  stopLoss: number;
  strike: string;
  quantity: number;
  initialTargetPoints: number;
  initialSlPoints: number;
  instrumentToken?: string;
  slOrderId?: string;
  entryPremium?: number;
  currentPremium?: number;
  targetPremium?: number;
  stopLossPremium?: number;
  lastSyncedStopLossPremium?: number;
  exitAlertReason?: "TRAILING_SL" | "FINAL_TARGET";
} | null;
type ExecutionMeta = {
  orderPlaced?: boolean;
  orderFilled?: boolean;
  orderStatus?: string;
  slActive?: boolean;
  trailingActive?: boolean;
  blocked?: string;
  slippageExit?: boolean;
};
type SlippageMeta = {
  quotedLtp?: number;
  fillPrice?: number;
  slippagePct?: number;
  tolerancePct?: number;
  withinTolerance?: boolean;
};
type LiquidityMeta = {
  ltp?: number;
  bid?: number;
  ask?: number;
  spread?: number;
  spreadPct?: number;
  volume?: number;
  maxSpreadPct?: number;
  minVolume?: number;
};
type LiveOrderResult = {
  success: boolean;
  instrument: { tradingSymbol: string; strike: number; optionType: string };
  instrumentToken?: string;
  quantity: number;
  availableCash: number;
  requiredCash: number;
  entryPremium: number;
  targetPremium: number;
  stopLossPremium: number;
  slOrderId?: string;
  slType?: string;
  slTriggerPrice?: number;
  slLimitPrice?: number;
  execution?: ExecutionMeta;
  slippage?: SlippageMeta;
  liquidity?: LiquidityMeta;
  error?: string;
  details?: string;
};
const EXEC_SETTINGS_KEY = "zenith-exec-settings-v1";
type ExecSettings = { slippagePct: number; maxSpreadPct: number; retries: number; liquidityFilter: boolean };
const DEFAULT_EXEC_SETTINGS: ExecSettings = { slippagePct: 1.5, maxSpreadPct: 2, retries: 2, liquidityFilter: true };
const loadExecSettings = (): ExecSettings => {
  try {
    const raw = storedValue(EXEC_SETTINGS_KEY);
    return raw ? { ...DEFAULT_EXEC_SETTINGS, ...JSON.parse(raw) } : DEFAULT_EXEC_SETTINGS;
  } catch {
    return DEFAULT_EXEC_SETTINGS;
  }
};

const Index = () => {
  const { toast } = useToast();
  const marketIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const aiIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const alertIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const retryToastRef = useRef(0);
  const marketPollInFlightRef = useRef(false);
  const lastUpstoxRequestAtRef = useRef(0);
  const upstoxBackoffUntilRef = useRef(0);
  const upstoxRequestQueueRef = useRef<Promise<void>>(Promise.resolve());
  const lastSignalAutofillRef = useRef("");
  const lastSignalAlertRef = useRef("");
  // v6: tracks whether user has manually edited Target/SL inputs for the current signal/trade.
  // Reset on new signal arrival; once true, auto-fill (signal sync + post-fill update) is skipped.
  const userEditedExitsRef = useRef(false);
  const previousSignalActionRef = useRef<string>("WAIT");
  const signalLockRef = useRef<{ signal: Signal; lockedUntil: number } | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [aiEnabled, setAiEnabled] = useState(
    () => storedValue(AI_ARMED_STORAGE_KEY) === "true" && isWithinMarketHours(),
  );
  const [autoTradeMode, setAutoTradeMode] = useState(() => storedValue(AUTO_TRADE_STORAGE_KEY) === "true");
  const lastAutoFiredSignalRef = useRef<string>("");
  const [riskMode, setRiskMode] = useState("moderate");
  const [tradingMode, setTradingMode] = useState<"scalping" | "sniper">(
    () => storedValue("zt_trading_mode", "scalping") as "scalping" | "sniper",
  );
  const [tradingLotSize, setTradingLotSize] = useState(() => storedValue(TRADING_LOT_SIZE_STORAGE_KEY, "1"));
  const [executedTrades, setExecutedTrades] = useState(
    () => Number.parseInt(datedStorageValue(TRADE_COUNT_STORAGE_KEY), 10) || 0,
  );
  const [activeTrade, setActiveTrade] = useState(() => datedStorageValue(ACTIVE_TRADE_STORAGE_KEY) === "true");
  const [activeTradePlan, setActiveTradePlan] = useState<ActiveTradePlan>(() => parseActiveTradePlan());
  const [userTargetPoints, setUserTargetPoints] = useState("");
  const [userSlPoints, setUserSlPoints] = useState("");
  const [dailyProfitTarget, setDailyProfitTarget] = useState(() => storedValue(DAILY_TARGET_STORAGE_KEY, "15000"));
  const [maxDailyLoss, setMaxDailyLoss] = useState(() =>
    storedValue(MAX_DAILY_LOSS_STORAGE_KEY, String(DAILY_STOP_LOSS)),
  );
  const [killSwitchDate, setKillSwitchDate] = useState(() => storedValue(KILL_SWITCH_STORAGE_KEY));
  const [cooldownUntil, setCooldownUntil] = useState(() => Number(storedValue(COOLDOWN_UNTIL_STORAGE_KEY, "0")) || 0);
  const [settings, setSettings] = useState({
    upstoxApiKey: storedValue(UPSTOX_CLIENT_ID_STORAGE_KEY),
    upstoxApiSecret: "",
    openaiApiKey: "",
    redirectUri: getUpstoxRedirectUri(storedValue(VPS_TUNNEL_URL_STORAGE_KEY, DEFAULT_FASTAPI_BASE_URL)),
    manualAccessToken: "",
  });
  const [vpsTunnelUrl, setVpsTunnelUrl] = useState(() => storedValue(VPS_TUNNEL_URL_STORAGE_KEY, DEFAULT_FASTAPI_BASE_URL));
  const normalizedVpsBaseUrl = getVpsBaseUrl(vpsTunnelUrl);
  const upstoxOAuthRedirectUri = getUpstoxRedirectUri(normalizedVpsBaseUrl);
  const [redirectUriManuallyEdited, setRedirectUriManuallyEdited] = useState(false);
  const [backendMode, setBackendMode] = useState<"AUTO" | "MANUAL" | "UNKNOWN">("UNKNOWN");
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);
  const [vpsSaveStatus, setVpsSaveStatus] = useState<{ ok: boolean; message: string; at: number } | null>(null);
  const [vpsStatusEndpoint, setVpsStatusEndpoint] = useState(() =>
    normalizeSavedStatusEndpoint(storedValue(VPS_STATUS_ENDPOINT_STORAGE_KEY, DEFAULT_VPS_STATUS_ENDPOINT)),
  );
  const [lastVpsError, setLastVpsError] = useState<{ at: number; where: string; message: string } | null>(null);
  const recordVpsError = (where: string, message: string) =>
    setLastVpsError({ at: Date.now(), where, message: message.slice(0, 400) });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [oauthCode, setOauthCode] = useState("");
  const [authorizationUrl, setAuthorizationUrl] = useState("");
  const [oauthDebugLog, setOauthDebugLog] = useState("No token exchange attempted yet.");
  const [latestData, setLatestData] = useState<NiftyData | null>(null);
  const [marketHistory, setMarketHistory] = useState<MarketPoint[]>([]);
  const [latestSignal, setLatestSignal] = useState<Signal | null>(null);
  const [suggestedEntryPremium, setSuggestedEntryPremium] = useState<number | null>(null);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(() => {
    if (typeof window === "undefined") return null;
    if (localStorage.getItem(UPSTOX_CONNECTED_FLAG_KEY) !== "true") return null;
    return {
      ready: false,
      upstox: { ok: true, message: "CONNECTED — saved Upstox session found. Verifying token in backend storage…" },
      gemini: { ok: false, message: "Run Re-test OpenAI to verify." },
      checkedAt: new Date().toISOString(),
    } as SystemStatus;
  });
  const [tunnelOnline, setTunnelOnline] = useState<boolean | null>(null);
  const [isCheckingStatus, setIsCheckingStatus] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [exitFlashUntil, setExitFlashUntil] = useState(0);
  const [marketClock, setMarketClock] = useState(() => new Date());
  const [ceSeries, setCeSeries] = useState<MarketPoint[]>([]);
  const [peSeries, setPeSeries] = useState<MarketPoint[]>([]);
  const ceStrikeRef = useRef<number | null>(null);
  const peStrikeRef = useRef<number | null>(null);
  const levelsAnchorLtpRef = useRef<number | null>(null);
  const lastForcedAiAtRef = useRef<number>(0);
  const [lastExecution, setLastExecution] = useState<LiveOrderResult | null>(null);
  const [execSettings, setExecSettings] = useState<ExecSettings>(() => loadExecSettings());
  const updateExecSettings = (patch: Partial<ExecSettings>) => {
    setExecSettings((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(EXEC_SETTINGS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  // ===== Execution Debug / Visibility Layer =====
  type DebugLevel = "info" | "success" | "warn" | "error";
  type DebugStage = "SIGNAL" | "ORDER" | "FILL" | "SL" | "TRAILING" | "ERROR";
  type DebugEvent = {
    id: string;
    ts: number;
    stage: DebugStage;
    level: DebugLevel;
    title: string;
    detail?: string;
    data?: Record<string, unknown>;
  };
  const [debugEvents, setDebugEvents] = useState<DebugEvent[]>([]);
  const lastDebugSignalKeyRef = useRef<string>("");
  const pushDebug = (e: Omit<DebugEvent, "id" | "ts">) => {
    const evt: DebugEvent = { ...e, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ts: Date.now() };
    setDebugEvents((prev) => [evt, ...prev].slice(0, 25));
    const tag = `[${evt.stage}]`;
    const payload = { detail: evt.detail, ...(evt.data ?? {}) };
    if (evt.level === "error") console.error(tag, evt.title, payload);
    else if (evt.level === "warn") console.warn(tag, evt.title, payload);
    else console.log(tag, evt.title, payload);
  };

  const applySniperSignal = (signal: Signal) => {
    const locked = signalLockRef.current;
    const now = Date.now();
    if (locked && now < locked.lockedUntil) {
      const fullReversal = signal.action !== "WAIT" && signal.action !== locked.signal.action;
      const majorBreak =
        signal.ruleContext?.rules?.priceAboveEma21 !== locked.signal.ruleContext?.rules?.priceAboveEma21 ||
        signal.ruleContext?.rules?.priceBelowEma21 !== locked.signal.ruleContext?.rules?.priceBelowEma21;
      if (signal.action === "WAIT" && !majorBreak) {
        setLatestSignal(locked.signal);
        return;
      }
      if (!fullReversal && signal.action !== locked.signal.action) {
        setLatestSignal(locked.signal);
        return;
      }
    }
    if (signal.action !== "WAIT") signalLockRef.current = { signal, lockedUntil: now + SIGNAL_LOCK_MS };
    else if (!locked || now >= locked.lockedUntil) signalLockRef.current = null;
    setLatestSignal(signal);
  };

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
  // Visual SL/Target overlay on index chart (mapped from previous candle distance used by auto-fill)
  const signalRules = latestSignal?.ruleContext?.rules as any;
  const signalAction = parseSuggestedAction(latestSignal);
  const visualEntryIndex = hasLivePrice ? latestLtp : null;
  const visualSlIndex =
    signalAction === "BUY" && Number.isFinite(signalRules?.previousLow)
      ? Number(signalRules.previousLow)
      : signalAction === "SELL" && Number.isFinite(signalRules?.previousHigh)
        ? Number(signalRules.previousHigh)
        : null;
  const visualTargetIndex =
    visualEntryIndex !== null && visualSlIndex !== null && signalAction
      ? signalAction === "BUY"
        ? visualEntryIndex + 2 * (visualEntryIndex - visualSlIndex)
        : visualEntryIndex - 2 * (visualSlIndex - visualEntryIndex)
      : null;
  const indexToY = (value: number) => 96 - ((value - chartMin) / chartRange) * 88;
  const slY = visualSlIndex !== null && chartValues.length ? indexToY(visualSlIndex) : null;
  const targetY = visualTargetIndex !== null && chartValues.length ? indexToY(visualTargetIndex) : null;
  const entryY = visualEntryIndex !== null && chartValues.length ? indexToY(visualEntryIndex) : null;
  // Yesterday's levels + immediate S/R from latest signal
  const yesterdayLevels = (latestData?.raw_payload as any)?.context?.yesterday ?? {};
  const pdhVal = toNumber(yesterdayLevels?.pdh);
  const pdlVal = toNumber(yesterdayLevels?.pdl);
  const pdcVal = toNumber(yesterdayLevels?.pdc);
  const rawImmediateSupport = toNumber(
    (latestSignal?.ruleContext?.rules as any)?.immediateSupport ?? (latestSignal?.ruleContext?.rules as any)?.support15,
  );
  const rawImmediateResistance = toNumber(
    (latestSignal?.ruleContext?.rules as any)?.immediateResistance ??
      (latestSignal?.ruleContext?.rules as any)?.resistance15,
  );
  // Hide S/R when implausibly far from current spot — prevents stale session levels from misleading.
  const srStale =
    Number.isFinite(latestLtp) &&
    ((rawImmediateSupport !== null && Math.abs(latestLtp - rawImmediateSupport) > SR_STALE_DISTANCE_PTS) ||
      (rawImmediateResistance !== null && Math.abs(latestLtp - rawImmediateResistance) > SR_STALE_DISTANCE_PTS));
  const immediateSupport = srStale ? null : rawImmediateSupport;
  const immediateResistance = srStale ? null : rawImmediateResistance;
  const pdhY =
    pdhVal !== null && chartValues.length && pdhVal >= chartMin && pdhVal <= chartMax ? indexToY(pdhVal) : null;
  const pdlY =
    pdlVal !== null && chartValues.length && pdlVal >= chartMin && pdlVal <= chartMax ? indexToY(pdlVal) : null;
  const pdcY =
    pdcVal !== null && chartValues.length && pdcVal >= chartMin && pdcVal <= chartMax ? indexToY(pdcVal) : null;
  const atmContext = (latestData?.raw_payload as any)?.context?.atm ?? {};
  const atmStrikeLive = toNumber(atmContext?.strike);
  const atmExpiry = atmContext?.expiry ?? null;
  const ceSymbol = atmContext?.ce?.tradingSymbol ?? (atmStrikeLive ? `Nifty ${atmStrikeLive} CE` : "ATM CE");
  const peSymbol = atmContext?.pe?.tradingSymbol ?? (atmStrikeLive ? `Nifty ${atmStrikeLive} PE` : "ATM PE");
  const ceLtpLive = toNumber(atmContext?.ce?.ltp);
  const peLtpLive = toNumber(atmContext?.pe?.ltp);
  const buildMiniPolyline = (series: MarketPoint[]) => {
    if (series.length < 2) return { points: "", min: 0, max: 0 };
    const vals = series.map((p) => p.value);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const range = Math.max(max - min, 0.01);
    const points = series
      .map((p, i) => {
        const x = (i / (series.length - 1)) * 100;
        const y = 92 - ((p.value - min) / range) * 84;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ");
    return { points, min, max };
  };
  const ceMini = buildMiniPolyline(ceSeries);
  const peMini = buildMiniPolyline(peSeries);
  const marketIsOpen = isWithinMarketHours(marketClock);
  const connectionLabel = !session
    ? "Sign In Required"
    : systemStatus?.ready
      ? marketIsOpen
        ? "System Live (Market Open)"
        : "System Ready (Market Closed)"
      : "Action Required";
  const connectionTone = !session
    ? "text-muted-foreground"
    : systemStatus?.ready
      ? marketIsOpen
        ? "text-profit"
        : "text-primary"
      : "text-loss";
  const connectionDot = !session
    ? "bg-muted-foreground"
    : systemStatus?.ready
      ? marketIsOpen
        ? "bg-profit"
        : "bg-primary"
      : "bg-loss";
  const highProbabilitySignal = Boolean(latestSignal?.highProbability);
  const normalizedTradingLotSize = Math.max(1, Number.parseInt(tradingLotSize, 10) || 1);
  const totalTradingQuantity = normalizedTradingLotSize * NIFTY_LOT_SIZE;
  const pcrValue = toNumber(latestSignal?.ruleContext?.rules?.pcr ?? latestData?.raw_payload?.optionChain?.pcr);
  const vixValue = toNumber(latestData?.raw_payload?.context?.indiaVix?.ltp);
  const suggestedQuantity = latestSignal?.riskSizeDown
    ? Math.max(NIFTY_LOT_SIZE, latestSignal.effectiveTradingQuantity ?? Math.floor(totalTradingQuantity / 2))
    : totalTradingQuantity;
  const aiPanelTone =
    latestSignal?.action === "BUY"
      ? "animate-pulse border-profit/70 shadow-[0_0_24px_hsl(var(--profit)/0.22)]"
      : latestSignal?.action === "WAIT"
        ? "border-warning/70"
        : highProbabilitySignal
          ? "animate-golden-blink border-warning/70"
          : "border-primary/25";
  const aiTextTone =
    latestSignal?.action === "BUY"
      ? "border-profit/60 text-foreground"
      : latestSignal?.action === "WAIT"
        ? "border-warning/70 text-foreground"
        : highProbabilitySignal
          ? "border-warning/70 text-foreground"
          : "border-border text-muted-foreground";
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
  const currentTradePnlPoints =
    activeTradePlan?.entryPremium && activeTradePlan?.currentPremium
      ? activeTradePlan.currentPremium - activeTradePlan.entryPremium
      : 0;
  const currentTradePnlMoney = activeTradePlan ? currentTradePnlPoints * activeTradePlan.quantity : 0;
  const exitAlertActive = Boolean(activeTradePlan?.exitAlertReason) || exitFlashUntil > Date.now();
  // TSL status: Armed (<+10pts) → Break-Even (>=+10pts) → Trailing +Npts (every additional 5pts)
  const TSL_ACTIVATION_POINTS = 6; // v7-aggressive: BE at +6pts (was 10)
  const tslActivated = currentTradePnlPoints >= TSL_ACTIVATION_POINTS;
  const tslLockedSteps = tslActivated
    ? Math.floor((currentTradePnlPoints - TSL_ACTIVATION_POINTS) / PREMIUM_TSL_STEP)
    : 0;
  const tslLockedPoints = tslActivated ? tslLockedSteps * PREMIUM_TSL_STEP : 0;
  const tslStatusLabel = !activeTradePlan
    ? "Idle"
    : !tslActivated
      ? `TSL Armed · activates at +${TSL_ACTIVATION_POINTS}pts (${Math.max(0, TSL_ACTIVATION_POINTS - currentTradePnlPoints).toFixed(1)} pts to go)`
      : tslLockedPoints === 0
        ? "TSL Active · SL @ Break-Even"
        : `TSL Trailing · locked +${tslLockedPoints}pts above entry`;
  const tslStatusTone = !activeTradePlan
    ? "border-border text-muted-foreground"
    : !tslActivated
      ? "border-warning/60 text-warning"
      : "border-profit/60 text-profit animate-pulse";

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession));
    return () => listener.subscription.unsubscribe();
  }, []);

  // Startup cleanup: drop any cached Upstox auth state so API Settings always
  // boots from a clean slate. The latest manual token (re-)entered by the user
  // is the only auth source we trust — no stale OAuth code, no stale flag.
  useEffect(() => {
    try {
      localStorage.removeItem(UPSTOX_CONNECTED_FLAG_KEY);
      localStorage.removeItem("zenith-upstox-oauth-code");
      localStorage.removeItem("zenith-upstox-oauth-state");
      sessionStorage.removeItem(UPSTOX_CONNECTED_FLAG_KEY);
      sessionStorage.removeItem("zenith-upstox-oauth-code");
      sessionStorage.removeItem("zenith-upstox-oauth-state");
    } catch {}
    setOauthCode("");
    setSettings((prev) => ({ ...prev, manualAccessToken: "" }));
    setSystemStatus(null);
  }, []);

  useEffect(() => {
    const clock = setInterval(() => setMarketClock(new Date()), 30_000);
    return () => clearInterval(clock);
  }, []);

  useEffect(() => {
    if (!redirectUriManuallyEdited) {
      setSettings((prev) =>
        prev.redirectUri === upstoxOAuthRedirectUri ? prev : { ...prev, redirectUri: upstoxOAuthRedirectUri },
      );
    }
    localStorage.setItem(VPS_TUNNEL_URL_STORAGE_KEY, normalizedVpsBaseUrl);
  }, [normalizedVpsBaseUrl, upstoxOAuthRedirectUri, redirectUriManuallyEdited]);


  useEffect(() => {
    localStorage.setItem(VPS_STATUS_ENDPOINT_STORAGE_KEY, vpsStatusEndpoint);
  }, [vpsStatusEndpoint]);

  // VPS tunnel health ping — every 5s. Drives the green "VPS TUNNEL ACTIVE" badge.
  useEffect(() => {
    const ping = async () => {
      try {
        const method = getStatusEndpointMethod(vpsStatusEndpoint);
        const r = await fetch(`${normalizedVpsBaseUrl}${vpsStatusEndpoint}`, {
          method,
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: method === "POST" ? JSON.stringify({ target: "upstox" }) : undefined,
        });
        setTunnelOnline(r.ok);
        if (!r.ok) {
          const txt = await r.text().catch(() => "");
          recordVpsError(`${method} ${vpsStatusEndpoint}`, `${r.status} ${txt || r.statusText}`);
        }
      } catch (err) {
        setTunnelOnline(false);
        recordVpsError(`${getStatusEndpointMethod(vpsStatusEndpoint)} ${vpsStatusEndpoint}`, err instanceof Error ? err.message : String(err));
      }
    };
    ping();
    const t = setInterval(ping, 5_000);
    return () => clearInterval(t);
  }, [normalizedVpsBaseUrl, vpsStatusEndpoint]);

  // Force-reset trades remaining to 4/4 on mount per user spec.
  useEffect(() => {
    setExecutedTrades(0);
    localStorage.setItem(TRADE_COUNT_STORAGE_KEY, `${todayKey()}:0`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      toast({
        title: cooldownActive
          ? "Cooldown Active"
          : targetAchieved
            ? "Target Achieved"
            : hardKillActive
              ? "Hard Kill-Switch Active"
              : "Max Trades Reached",
        description: cooldownActive
          ? `AI trading paused for ${cooldownRemainingMinutes} more minutes.`
          : targetAchieved
            ? "Daily profit target reached. AI trading is stopped for the day."
            : hardKillActive
              ? "₹2000 daily stop loss reached. Trading is locked for the day."
              : "4-trade daily cap reached. AI trading is stopped for the day.",
        variant: targetAchieved || cooldownActive ? "default" : "destructive",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeTrade,
    aiEnabled,
    cooldownActive,
    cooldownRemainingMinutes,
    hardKillActive,
    killSwitchDate,
    maxTradesHit,
    targetAchieved,
    toast,
    tradingBlocked,
  ]);

  useEffect(() => {
    const strike = parseSuggestedStrike(latestSignal?.strike);
    const action = parseSuggestedAction(latestSignal);
    if (!latestSignal || !action || !strike || activeTrade) return;
    const signalKey = `${latestSignal.created_at ?? ""}-${latestSignal.action}-${latestSignal.strike}`;
    if (signalKey === lastSignalAutofillRef.current) return;
    lastSignalAutofillRef.current = signalKey;
    // New signal → reset manual-edit flag so auto-fill can populate fresh values.
    userEditedExitsRef.current = false;
    invokeFunction<{ premium: number; instrument?: { tradingSymbol?: string } }>("fetch-option-premium", {
      strike,
      action,
    })
      .then(({ premium, instrument }) => {
        const rules = latestSignal.ruleContext?.rules as any;
        const ltpNow = Number(latestData?.ltp);
        let slPts: number | undefined;
        if (Number.isFinite(ltpNow)) {
          if (action === "BUY" && Number.isFinite(rules?.previousLow))
            slPts = Math.max(5, Math.round(ltpNow - rules.previousLow));
          if (action === "SELL" && Number.isFinite(rules?.previousHigh))
            slPts = Math.max(5, Math.round(rules.previousHigh - ltpNow));
        }
        const tgtPts = slPts ? slPts * 2 : undefined;
        const exits = calculatePremiumExitPrices(premium, slPts, tgtPts);
        // v6-safe: prefer backend-computed premiumTarget/premiumSL from signal when available.
        const sigTarget = Number((latestSignal as any)?.premiumTarget);
        const sigSl = Number((latestSignal as any)?.premiumSL);
        const finalTarget = Number.isFinite(sigTarget) && sigTarget > 0 ? sigTarget : exits.targetPremium;
        const finalSl = Number.isFinite(sigSl) && sigSl > 0 ? sigSl : exits.stopLossPremium;
        setSuggestedEntryPremium(premium);
        // Respect user manual edits: only auto-fill if user hasn't typed into the fields.
        if (!userEditedExitsRef.current) {
          setUserTargetPoints(formatPremiumInput(finalTarget));
          setUserSlPoints(formatPremiumInput(finalSl));
        }
        toast({
          title: "Scalper auto-fill ready",
          description: `${instrument?.tradingSymbol ?? latestSignal.strike} LTP ₹${premium.toFixed(2)} · SL ₹${finalSl.toFixed(2)} · Target ₹${finalTarget.toFixed(2)}.`,
        });
      })
      .catch((error) => {
        toast({
          title: "Premium LTP fetch failed",
          description: error instanceof Error ? error.message : "Could not fetch option premium from Upstox.",
          variant: "destructive",
        });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTrade, latestSignal?.action, latestSignal?.created_at, latestSignal?.strike]);

  // Instant Strike Update: when live ATM moves and there's no active trade, drop stale suggested premium and force a re-autofill on the next signal.
  const liveAtmStrike = hasLivePrice ? Math.round(latestLtp / 50) * 50 : null;
  const lastAtmStrikeRef = useRef<number | null>(null);
  useEffect(() => {
    if (liveAtmStrike === null) return;
    if (lastAtmStrikeRef.current !== null && lastAtmStrikeRef.current !== liveAtmStrike && !activeTrade) {
      setSuggestedEntryPremium(null);
      lastSignalAutofillRef.current = "";
    }
    lastAtmStrikeRef.current = liveAtmStrike;
  }, [liveAtmStrike, activeTrade]);

  useEffect(() => {
    if (!activeTradePlan?.entryPremium || !activeTradePlan.currentPremium || activeTradePlan.exitAlertReason) return;
    const currentStop = activeTradePlan.stopLossPremium ?? activeTradePlan.stopLoss;
    const currentTarget = activeTradePlan.targetPremium ?? activeTradePlan.target;
    const premiumProfit = activeTradePlan.currentPremium - activeTradePlan.entryPremium;
    const stopHit = activeTradePlan.currentPremium <= currentStop;
    const targetHit = activeTradePlan.currentPremium >= currentTarget;
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
      const candidateStop =
        activeTradePlan.entryPremium - activeTradePlan.initialSlPoints + lockedSteps * PREMIUM_TSL_STEP;
      const candidateTarget =
        activeTradePlan.entryPremium + activeTradePlan.initialTargetPoints + lockedSteps * PREMIUM_TSL_STEP;
      const shouldTrail = candidateStop > currentStop;
      if (shouldTrail) {
        const nextPlan = {
          ...activeTradePlan,
          targetPremium: candidateTarget,
          target: candidateTarget,
          stopLossPremium: candidateStop,
          stopLoss: candidateStop,
        };
        setActiveTradePlan(nextPlan);
        setUserTargetPoints(formatPremiumInput(candidateTarget));
        setUserSlPoints(formatPremiumInput(candidateStop));
        localStorage.setItem(ACTIVE_TRADE_PLAN_STORAGE_KEY, `${todayKey()}:${JSON.stringify(nextPlan)}`);
        syncStopLossPremium(nextPlan).catch((error) =>
          showRetryToast(error instanceof Error ? error.message : "Server SL modify will retry."),
        );
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTradePlan]);

  useEffect(() => {
    const previousAction = previousSignalActionRef.current;
    previousSignalActionRef.current = latestSignal?.action ?? "WAIT";
    if (!isTradeSignal(latestSignal?.action)) return;
    const signalKey = `${latestSignal?.created_at ?? ""}-${latestSignal?.action}-${latestSignal?.strike}`;
    if (signalKey === lastSignalAlertRef.current) return;
    lastSignalAlertRef.current = signalKey;
    triggerSignalAlert(latestSignal as Signal, previousAction === "WAIT");
    if (signalKey !== lastDebugSignalKeyRef.current) {
      lastDebugSignalKeyRef.current = signalKey;
      const sigPremium = Number((latestSignal as any)?.entryPremium ?? (latestSignal as any)?.premiumEntry);
      pushDebug({
        stage: "SIGNAL",
        level: "success",
        title: `SIGNAL GENERATED: ${latestSignal?.action}`,
        detail: `${latestSignal?.strike ?? "—"} @ ₹${Number.isFinite(sigPremium) ? sigPremium.toFixed(2) : "—"}`,
        data: {
          action: latestSignal?.action,
          strike: latestSignal?.strike,
          entryPrice: Number.isFinite(sigPremium) ? sigPremium : null,
          conviction: latestSignal?.conviction,
          createdAt: latestSignal?.created_at,
        },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestSignal?.action, latestSignal?.created_at, latestSignal?.strike]);

  const handleTargetPointsChange = (value: string) => {
    setUserTargetPoints(value);
    userEditedExitsRef.current = true;
    const targetPremium = Number(value);
    if (!activeTradePlan || !Number.isFinite(targetPremium) || targetPremium <= 0) return;
    const entry = activeTradePlan.entryPremium ?? activeTradePlan.entry;
    const points = Math.abs(targetPremium - entry);
    const nextPlan = { ...activeTradePlan, targetPremium, target: targetPremium, initialTargetPoints: points };
    setActiveTradePlan(nextPlan);
    localStorage.setItem(ACTIVE_TRADE_PLAN_STORAGE_KEY, `${todayKey()}:${JSON.stringify(nextPlan)}`);
  };

  const handleSlPointsChange = (value: string) => {
    setUserSlPoints(value);
    userEditedExitsRef.current = true;
    const stopLossPremium = Number(value);
    if (!activeTradePlan || !Number.isFinite(stopLossPremium) || stopLossPremium <= 0) return;
    const entry = activeTradePlan.entryPremium ?? activeTradePlan.entry;
    const points = Math.abs(entry - stopLossPremium);
    const nextPlan = { ...activeTradePlan, stopLossPremium, stopLoss: stopLossPremium, initialSlPoints: points };
    setActiveTradePlan(nextPlan);
    localStorage.setItem(ACTIVE_TRADE_PLAN_STORAGE_KEY, `${todayKey()}:${JSON.stringify(nextPlan)}`);
    syncStopLossPremium(nextPlan).catch((error) =>
      showRetryToast(error instanceof Error ? error.message : "Server SL modify will retry."),
    );
  };

  const unlockAudio = () => {
    const AudioCtor =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) return null;
    const context = audioContextRef.current ?? new AudioCtor();
    audioContextRef.current = context;
    if (context.state === "suspended") context.resume().catch(() => undefined);
    return context;
  };

  const playAlertTone = (tone: "exit" | "BUY" | "SELL" = "exit") => {
    const context = unlockAudio();
    if (!context) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = tone === "BUY" ? "sine" : "square";
    oscillator.frequency.value = tone === "BUY" ? 1320 : tone === "SELL" ? 220 : 880;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(tone === "SELL" ? 0.16 : 0.12, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + (tone === "SELL" ? 0.55 : 0.42));
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + (tone === "SELL" ? 0.58 : 0.45));
  };

  const triggerSignalAlert = (signal: Signal, vibrate = false) => {
    if (!isTradeSignal(signal.action)) return;
    playAlertTone(signal.action as "BUY" | "SELL");
    if (vibrate && navigator.vibrate) navigator.vibrate(signal.action === "BUY" ? [80, 40, 80] : [180]);
  };

  useEffect(() => {
    const armAudio = () => unlockAudio();
    window.addEventListener("pointerdown", armAudio, { passive: true });
    window.addEventListener("keydown", armAudio);
    return () => {
      window.removeEventListener("pointerdown", armAudio);
      window.removeEventListener("keydown", armAudio);
    };
  }, []);

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
      if (Date.now() < upstoxBackoffUntilRef.current) return;
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

  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const isUpstoxRateLimitError = (message: string) =>
    message.includes(UPSTOX_RATE_LIMIT_ERROR) || message.toLowerCase().includes("too many requests");
  const applyUpstoxBackoff = (retryAfterMs = UPSTOX_RATE_LIMIT_BACKOFF_MS) => {
    upstoxBackoffUntilRef.current = Math.max(
      upstoxBackoffUntilRef.current,
      Date.now() + Math.max(retryAfterMs, UPSTOX_RATE_LIMIT_BACKOFF_MS),
    );
    showRetryToast("Upstox rate limit hit (UDAPI10005). Waiting 5 seconds before retrying to avoid IP block.");
  };

  const throttleUpstoxRequest = async () => {
    upstoxRequestQueueRef.current = upstoxRequestQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const now = Date.now();
        const waitForBackoff = Math.max(0, upstoxBackoffUntilRef.current - now);
        if (waitForBackoff > 0) await delay(waitForBackoff);
        const waitForThrottle = Math.max(0, UPSTOX_POLL_INTERVAL_MS - (Date.now() - lastUpstoxRequestAtRef.current));
        if (waitForThrottle > 0) await delay(waitForThrottle);
        lastUpstoxRequestAtRef.current = Date.now();
      });
    await upstoxRequestQueueRef.current;
  };

  const markUpstoxRateLimited = (message: string) => {
    if (!isUpstoxRateLimitError(message)) return false;
    applyUpstoxBackoff();
    return true;
  };

  const resetDailyTradeQuota = () => {
    setExecutedTrades(0);
    localStorage.setItem(TRADE_COUNT_STORAGE_KEY, `${todayKey()}:0`);
  };

  const restoreSavedUpstoxSession = async () => {
    const { data, error } = await supabase.functions.invoke<UpstoxStatus>("system-status", {
      body: { target: "upstox", tokenOnly: true },
    });
    if (error) throw error;
    if (!data?.upstox?.ok) return data;
    localStorage.setItem(UPSTOX_CONNECTED_FLAG_KEY, "true");
    setSystemStatus((prev) => {
      const gemini = prev?.gemini ?? { ok: false, message: "Run Re-test OpenAI to confirm OpenAI API status." };
      return { ready: true, upstox: data.upstox, gemini, checkedAt: data.checkedAt };
    });
    return data;
  };

  const modeLabel = tradingMode === "scalping" ? "Scalping Mode" : "Sniper Mode";
  const reasoning = useMemo(() => {
    if (latestSignal) {
      const rules = latestSignal.ruleContext?.rules;
      const triggered = [
        `${modeLabel} active`,
        rules?.sustainedBullish1m && "3 bullish 1m candles",
        rules?.sustainedBearish1m && "3 bearish 1m candles",
        rules?.priceAboveEma21 && "Price > 21 EMA",
        rules?.priceBelowEma21 && "Price < 21 EMA",
        rules?.vixStable && "VIX stable",
        rules?.fakeBreakout && "POTENTIAL TRAP",
        rules?.vixRising && "VIX risk size-down",
        rules?.europeanOpenCaution && "European open caution",
        rules?.overextended && "Overextended Zone",
        rules?.noTradeRange && "No-Trade Zone",
        rules?.divergence && "Low Conviction divergence",
        rules?.volumeValid && "Volume +20% confirmed",
        rules?.emaAligned && `EMA ${rules.emaTrend} aligned`,
        rules?.multiTimeframeAligned && `5m confirms 1m ${rules.entry1m}`,
        rules?.vixSizeCut && "VIX >5% size -50%",
        rules?.pcrState && `PCR ${rules.pcrState}`,
      ]
        .filter(Boolean)
        .join(" · ");
      return `Current Mode: ${modeLabel} — ${latestSignal.action === "WAIT" ? "WAITING FOR CONFIRMATION" : `${latestSignal.action} LOCKED`} ${latestSignal.strike} · ${latestSignal.conviction ?? "MEDIUM"} Conviction${triggered ? ` · ${triggered}` : ""} — ${latestSignal.reason}`;
    }
    if (targetAchieved)
      return `Current Mode: ${modeLabel} — Target Achieved: daily profit goal reached. AI trading is stopped for the day.`;
    if (hardKillActive)
      return `Current Mode: ${modeLabel} — Hard Kill-Switch Active: max daily loss reached. Trading is disabled for the day.`;
    if (!aiEnabled)
      return `Current Mode: ${modeLabel} — Analyzing market trends... AI engine is standing by for confirmation.`;
    if (riskMode === "conservative")
      return `Current Mode: ${modeLabel} — AI loop armed: waiting for high-confidence RSI and trend confirmation.`;
    if (riskMode === "aggressive")
      return `Current Mode: ${modeLabel} — AI loop armed: scanning momentum breakouts with tight VWAP risk control.`;
    return `Current Mode: ${modeLabel} — AI loop armed: streaming Upstox prices every 5 seconds while OpenAI confirms trend every 30 seconds.`;
  }, [aiEnabled, hardKillActive, latestSignal, riskMode, targetAchieved, modeLabel, tradingMode]);

  const signIn = async (event: FormEvent) => {
    event.preventDefault();
    const { error } = await supabase.auth.signInWithPassword({ email: authEmail, password: authPassword });
    if (error) {
      const signup = await supabase.auth.signUp({ email: authEmail, password: authPassword });
      if (signup.error)
        toast({ title: "Authentication failed", description: signup.error.message, variant: "destructive" });
      else
        toast({
          title: "Check your inbox",
          description: "Confirm your email, then sign in to manage trading settings.",
        });
    }
  };

  const signInWithGoogle = async () => {
    const result = await lovable.auth.signInWithOAuth("google", { redirect_uri: window.location.origin });
    if (result.error)
      toast({ title: "Google sign-in failed", description: result.error.message, variant: "destructive" });
  };

  const invokeFunction = async <T,>(name: string, body?: Record<string, unknown>) => {
    const touchesUpstox = [
      "fetch-nifty-data",
      "fetch-option-premium",
      "system-status",
      "place-live-order",
      "modify-stop-loss-order",
      "emergency-exit",
    ].includes(name);
    if (touchesUpstox) await throttleUpstoxRequest();

    // Route Upstox execution + OAuth through the VPS FastAPI backend (static IPv4).
    // Edge functions remain deployed as fallback but are no longer the primary path.
    // Route Upstox read-only market data + OAuth through the VPS FastAPI backend
    // (static IPv4). Trading order placement / modification / exits still go
    // through Supabase edge functions because they contain the full execution
    // layer (slippage guard, SL placement, fill polling, liquidity checks, DB
    // tracking) that the VPS pass-through does not replicate.
    // Route Upstox execution + OAuth through the VPS FastAPI backend (static
    // IPv4). The OAuth access token lives in VPS settings.json, so every
    // Upstox-touching call must go to VPS — Supabase edge functions no longer
    // have the token and would 400 with "Connect Upstox OAuth".
    const VPS_ROUTED = new Set([
      "fetch-nifty-data",
      "fetch-option-premium",
      "place-live-order",
      "modify-stop-loss-order",
      "emergency-exit",
      "upstox-oauth",
    ]);
    // system-status is split: Upstox token lives on VPS (settings.json),
    // OpenAI key lives in Supabase. Route by target so each check hits the
    // place that actually has the credential.
    let routeToVps = VPS_ROUTED.has(name);
    if (name === "system-status") {
      const target = (body as { target?: string } | undefined)?.target;
      routeToVps = target === "upstox";
    }
    if (routeToVps) {
      // VPS endpoint mapping: order placement uses `/place-order` on the VPS
      // (FastAPI backend handles the actual Upstox API call with stored token).
      const VPS_PATH_OVERRIDES: Record<string, string> = {
        "place-live-order": "/place-order",
      };
      const path =
        name === "system-status"
          ? vpsStatusEndpoint
          : VPS_PATH_OVERRIDES[name] ?? `/${name}`;
      const method = name === "system-status" ? getStatusEndpointMethod(path) : "POST";
      try {
        // Headers tuned for Cloudflare tunnel + CORS:
        //  - Only set Content-Type on POST (avoids unnecessary preflight on GET)
        //  - mode: "cors" + credentials: "omit" → simple CORS, no cookies
        //  - cache: "no-store" → prevents stale tunnel responses
        const headers: Record<string, string> = { Accept: "application/json" };
        if (method === "POST") headers["Content-Type"] = "application/json";
        const res = await fetch(`${normalizedVpsBaseUrl}${path}`, {
          method,
          headers,
          body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
          mode: "cors",
          credentials: "omit",
          cache: "no-store",
        });
        const text = await res.text();
        const payload = text
          ? (() => {
              try {
                return JSON.parse(text);
              } catch {
                return { error: text };
              }
            })()
          : {};
        if (!res.ok) {
          const serverMessage = (payload?.error || payload?.detail || `VPS ${res.status}`) as string;
          const message = serverMessage.includes(UPSTOX_INVALID_CODE_ERROR)
            ? "Invalid Auth code. Upstox authorization codes are single-use; tap Get Code and paste a brand-new code."
            : serverMessage.includes(UPSTOX_INVALID_TOKEN_ERROR) ||
                serverMessage.toLowerCase().includes("upstox oauth reconnect required")
              ? (localStorage.removeItem(UPSTOX_CONNECTED_FLAG_KEY),
                "Upstox OAuth reconnect required. Open API Settings, tap Get Code, finish Upstox login, paste the fresh code, then Connect.")
              : serverMessage;
          recordVpsError(`${method} ${path}`, `${res.status} ${message}`);
          markUpstoxRateLimited(message);
          throw new Error(message);
        }
        if (name === "system-status" && method === "GET") {
          return {
            upstox: {
              ok: true,
              message: `VPS reachable at ${path}. Saved Upstox session remains CONNECTED while token is stored in backend.`,
              details: payload,
            },
            checkedAt: new Date().toISOString(),
          } as T;
        }
        return payload as T;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.toLowerCase().includes("failed to fetch")) {
          recordVpsError(`${method} ${path}`, "network failure (failed to fetch)");
          throw new Error("VPS backend unreachable. Check the FastAPI Cloudflare tunnel is running and the URL in API Settings is correct.");
        }
        throw err;
      }
    }

    const { data, error } = await supabase.functions.invoke<T>(name, { body });
    if (error) {
      let serverMessage = error.message;
      const context = (error as unknown as { context?: Response }).context;
      if (context) {
        const payload = await (async () => {
          try {
            const src = typeof (context as Response)?.clone === "function" ? (context as Response).clone() : context;
            if (src && typeof (src as Response).json === "function") {
              return await (src as Response).json();
            }
            if (src && typeof (src as Response).text === "function") {
              const txt = await (src as Response).text();
              try { return JSON.parse(txt); } catch { return { error: txt }; }
            }
            return src ?? null;
          } catch {
            return null;
          }
        })();
        serverMessage = [payload?.error, payload?.details].filter(Boolean).join(" — ") || serverMessage;
      }
      const message = serverMessage.includes(UPSTOX_INVALID_CODE_ERROR)
        ? "Invalid Auth code. Upstox authorization codes are single-use; tap Get Code and paste a brand-new code."
        : serverMessage.includes(UPSTOX_INVALID_TOKEN_ERROR) ||
            serverMessage.toLowerCase().includes("upstox oauth reconnect required")
          ? "Upstox OAuth reconnect required. Open API Settings, tap Get Code, finish Upstox login, paste the fresh code, then Connect."
          : serverMessage;
      markUpstoxRateLimited(message);
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
    const previousSl = plan.lastSyncedStopLossPremium ?? plan.stopLoss;
    const profitPts = plan.entryPremium ? (plan.currentPremium ?? plan.entryPremium) - plan.entryPremium : 0;
    try {
      await invokeFunction("modify-stop-loss-order", {
        orderId: plan.slOrderId,
        quantity: plan.quantity,
        triggerPrice: plan.stopLossPremium,
      });
      setActiveTradePlan((current) => {
        if (!current || current.slOrderId !== plan.slOrderId) return current;
        const currentStop = current.stopLossPremium ?? current.stopLoss;
        const syncedStop = plan.stopLossPremium ?? plan.stopLoss;
        const sameStop = currentStop === syncedStop;
        if (!sameStop) return current;
        const syncedPlan = { ...current, lastSyncedStopLossPremium: plan.stopLossPremium };
        localStorage.setItem(ACTIVE_TRADE_PLAN_STORAGE_KEY, `${todayKey()}:${JSON.stringify(syncedPlan)}`);
        return syncedPlan;
      });
      pushDebug({
        stage: "TRAILING",
        level: "success",
        title: "TRAILING ACTIVE",
        detail: `SL ₹${previousSl.toFixed(2)} → ₹${plan.stopLossPremium.toFixed(2)} · profit +${profitPts.toFixed(1)}pts`,
        data: {
          orderId: plan.slOrderId,
          previousSl,
          newSl: plan.stopLossPremium,
          profitPoints: Number(profitPts.toFixed(2)),
        },
      });
      toast({
        title: "Server SL updated",
        description: `Upstox SL-M trigger moved to ₹${plan.stopLossPremium.toFixed(2)}.`,
      });
    } catch (err) {
      pushDebug({
        stage: "ERROR",
        level: "error",
        title: "TRAILING FAILED",
        detail: err instanceof Error ? err.message : String(err),
        data: { previousSl, attemptedSl: plan.stopLossPremium },
      });
      throw err;
    }
  };

  const saveUpstoxSettings = async () => {
    setIsBusy(true);
    const url = `${normalizedVpsBaseUrl}/upstox-credentials`;
    const body = {
      apiKey: settings.upstoxApiKey,
      apiSecret: settings.upstoxApiSecret,
      redirectUri: upstoxOAuthRedirectUri,
      userId: session?.user?.id,
    };
    console.log("[Upstox Save] FASTAPI_BASE_URL =", normalizedVpsBaseUrl);
    console.log("[Upstox Save] POST", url);
    try {
      let vpsRes: Response;
      try {
        vpsRes = await fetch(url, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (netErr) {
        console.error("[Upstox Save] network error", netErr);
        setVpsSaveStatus({ ok: false, message: "VPS unreachable (network error)", at: Date.now() });
        throw new Error("VPS backend unreachable. Check the FastAPI Cloudflare tunnel is running and the URL in API Settings is correct.");
      }
      const text = await vpsRes.text().catch(() => "");
      console.log("[Upstox Save] status", vpsRes.status, "body", text);
      if (vpsRes.status !== 200) {
        setVpsSaveStatus({ ok: false, message: `VPS ${vpsRes.status}: ${text || "save failed"}`, at: Date.now() });
        throw new Error(`VPS ${vpsRes.status}: ${text || "save failed"}`);
      }
      localStorage.setItem(UPSTOX_CLIENT_ID_STORAGE_KEY, settings.upstoxApiKey.trim());
      setVpsSaveStatus({ ok: true, message: "Saved to VPS", at: Date.now() });
      setSettings((prev) => ({ ...prev, upstoxApiKey: settings.upstoxApiKey.trim(), upstoxApiSecret: "" }));
      toast({
        title: "Upstox keys saved",
        description: "Credentials persisted to VPS. You may now click Get Code.",
      });
      await retestUpstox(false).catch(() => null);
    } catch (error) {
      toast({
        title: "Unable to save Upstox",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsBusy(false);
    }
  };

  const clearSavedSession = async () => {
    try {
      // Wipe every Upstox-related browser storage key we know about.
      const keysToWipe = [
        UPSTOX_CONNECTED_FLAG_KEY,
        UPSTOX_CLIENT_ID_STORAGE_KEY,
        "zenith-upstox-oauth-code",
        "zenith-upstox-oauth-state",
      ];
      keysToWipe.forEach((k) => {
        try { localStorage.removeItem(k); } catch {}
        try { sessionStorage.removeItem(k); } catch {}
      });
    } catch {}
    setOauthCode("");
    setAuthorizationUrl("");
    setSettings((prev) => ({ ...prev, manualAccessToken: "", upstoxApiSecret: "" }));
    setSystemStatus(null);
    // Best-effort: tell the VPS to drop its cached token so the next request is unauthenticated
    // until a fresh manual token is saved.
    try {
      await fetch(`${normalizedVpsBaseUrl}/upstox-token`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken: "", apiKey: "", apiSecret: "", userId: session?.user?.id, clear: true }),
      }).catch(() => null);
    } catch {}
    toast({
      title: "Saved session cleared",
      description: "Local storage, OAuth state, and cached tokens wiped. Paste a fresh Permanent Access Token to reconnect.",
    });
  };

  const saveManualAccessToken = async () => {
    const token = settings.manualAccessToken.trim();
    if (!token) {
      toast({ title: "Paste your access token first", variant: "destructive" });
      return;
    }
    // Overwrite any previously cached connection flags so the new token is the
    // only source of truth. Old OAuth tokens must NOT linger.
    try {
      localStorage.removeItem(UPSTOX_CONNECTED_FLAG_KEY);
      sessionStorage.removeItem(UPSTOX_CONNECTED_FLAG_KEY);
      localStorage.removeItem("zenith-upstox-oauth-code");
      sessionStorage.removeItem("zenith-upstox-oauth-code");
    } catch {}
    setOauthCode("");
    setIsBusy(true);
    try {
      await invokeFunction("save-trading-settings", { provider: "upstox-token", upstoxAccessToken: token });

      // Push to VPS so /fetch-nifty-data, /place-order etc. can authorise.
      // Without this the VPS keeps replying "Connect Upstox OAuth before fetching market data."
      let vpsPushOk = false;
      let vpsPushMessage = "";
      try {
        const vpsRes = await fetch(`${normalizedVpsBaseUrl}/upstox-token`, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({
            accessToken: token,
            access_token: token,
            upstoxAccessToken: token,
            upstox_access_token: token,
            manualAccessToken: token,
            token,
            apiKey: settings.upstoxApiKey?.trim() || undefined,
            upstoxApiKey: settings.upstoxApiKey?.trim() || undefined,
            apiSecret: settings.upstoxApiSecret?.trim() || undefined,
            upstoxApiSecret: settings.upstoxApiSecret?.trim() || undefined,
            userId: session?.user?.id,
            user_id: session?.user?.id,
          }),
        });
        const vpsText = await vpsRes.text();
        vpsPushOk = vpsRes.ok;
        vpsPushMessage = vpsText;
        if (!vpsRes.ok) console.warn("[Manual Token] VPS push HTTP", vpsRes.status, vpsText);
      } catch (vpsErr) {
        console.warn("[Manual Token] VPS push failed:", vpsErr);
        vpsPushMessage = vpsErr instanceof Error ? vpsErr.message : String(vpsErr);
      }

      try { localStorage.setItem(UPSTOX_CONNECTED_FLAG_KEY, "true"); } catch {}
      setSystemStatus((prev) => ({
        ready: prev?.gemini?.ok === true,
        upstox: {
          ok: true,
          message: vpsPushOk
            ? "CONNECTED — manual access token stored on VPS."
            : "CONNECTED in Supabase. VPS push failed — ensure the FastAPI tunnel exposes POST /upstox-token, then re-save.",
        },
        gemini: prev?.gemini ?? { ok: false, message: "Run Re-test OpenAI to verify." },
        checkedAt: new Date().toISOString(),
      } as SystemStatus));
      if (vpsPushOk) setSettings((prev) => ({ ...prev, manualAccessToken: "" }));

      toast({
        title: "Access token saved",
        description: vpsPushOk
          ? "Status: CONNECTED. Live data + orders will use this token."
          : `Saved to Supabase, but VPS push failed: ${vpsPushMessage.slice(0, 200)}`,
        variant: vpsPushOk ? undefined : "destructive",
      });

      retestUpstox(false).catch(() => null);
    } catch (error) {
      toast({
        title: "Unable to save access token",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
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
      toast({
        title: status?.gemini.ok ? "OpenAI verified" : "OpenAI key saved",
        description: status?.gemini.message ?? "Existing Upstox token and settings were left unchanged.",
      });
    } catch (error) {
      toast({
        title: "Unable to save OpenAI",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsBusy(false);
    }
  };

  const startUpstoxOAuth = async () => {
    const rawVpsUrl = vpsTunnelUrl.trim();
    if (!rawVpsUrl) {
      setOauthDebugLog("Please enter VPS URL");
      toast({ title: "Please enter VPS URL", variant: "destructive" });
      return;
    }
    try {
      const parsedVps = new URL(rawVpsUrl);
      if (!/^https?:$/.test(parsedVps.protocol)) throw new Error("Invalid VPS URL");
      const vpsBase = getVpsBaseUrl(rawVpsUrl);
      const manualRedirect = settings.redirectUri.trim();
      const redirectUri = manualRedirect || getUpstoxRedirectUri(vpsBase);
      const clientId = settings.upstoxApiKey.trim() || storedValue(UPSTOX_CLIENT_ID_STORAGE_KEY).trim();
      if (!clientId) throw new Error("Enter Upstox API Key / Client ID first, then tap Get Code.");
      localStorage.setItem(VPS_TUNNEL_URL_STORAGE_KEY, vpsBase);
      localStorage.setItem(UPSTOX_CLIENT_ID_STORAGE_KEY, clientId);
      setVpsTunnelUrl(vpsBase);
      const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code" });
      const authUrl = `https://api.upstox.com/v2/login/authorization/dialog?${params.toString()}`;
      setAuthorizationUrl(authUrl);
      setSettings((prev) => ({ ...prev, redirectUri }));
      setOauthCode("");
      setOauthDebugLog(
        `Fresh Authorization URL generated.\nredirect_uri=${redirectUri}\nEncoded redirect_uri=${encodeURIComponent(redirectUri)}\nPaste only the new code from this login attempt.`,
      );
      // Open in a new tab so the dashboard stays mounted while the user logs in.
      const popup = window.open(authUrl, "_blank", "noopener,noreferrer");
      if (!popup) throw new Error("Popup blocked. Allow popups for this app, then tap Get Code again.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Save settings first.";
      setOauthDebugLog(
        `Get Code failed.\nVPS: ${normalizedVpsBaseUrl}/upstox-oauth\nError: ${message}\nCheck backend logs for [upstox-oauth] line.`,
      );
      toast({
        title: "OAuth start failed",
        description: message,
        variant: "destructive",
      });
    }
  };

  const completeUpstoxOAuth = async () => {
    const debugRedirectUri = upstoxOAuthRedirectUri;
    const trimmedCode = oauthCode.trim();
    setOauthDebugLog(
      `Token exchange payload sent to Upstox:\nmode=token\ncode=${trimmedCode}\nredirect_uri=${debugRedirectUri}\nUse a fresh OAuth code for each retry.`,
    );
    try {
      await invokeFunction("upstox-oauth", { mode: "token", code: trimmedCode, redirectUri: debugRedirectUri, userId: session?.user?.id });
      setOauthCode("");
      localStorage.setItem(UPSTOX_CONNECTED_FLAG_KEY, "true");
      setOauthDebugLog(
        `Token exchange succeeded.\ncode=${trimmedCode}\nredirect_uri=${debugRedirectUri}\nThis code has now been used and cannot be submitted again.`,
      );
      await checkSystemStatus(false).catch(() => null);
      await fetchLiveNifty(false, true);
      toast({
        title: "Upstox connected",
        description: "Access token saved securely for server-side market data calls.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Check the authorization code.";
      const isInvalidCode =
        message.includes(UPSTOX_INVALID_CODE_ERROR) || message.toLowerCase().includes("invalid auth code");
      if (isInvalidCode) {
        setOauthCode("");
        setOauthDebugLog(
          `Upstox rejected this code as invalid or already used.\ncode=${trimmedCode}\nredirect_uri=${debugRedirectUri}\nNext step: tap Get Code, complete login again, and paste the brand-new code.`,
        );
      }
      toast({
        title: isInvalidCode ? "Fresh OAuth code required" : "OAuth exchange failed",
        description: message,
        variant: "destructive",
      });
    }
  };

  const fetchLiveNifty = async (executionIntent = false, _skipReadyCheck = true) => {
    // OAuth gating removed: REST polling uses the manual access token stored on the VPS.
    const market = await invokeFunction<MarketFetchResult | (NiftyData & Record<string, unknown>)>("fetch-nifty-data", {
      tradingLotSize: normalizedTradingLotSize,
      tradingQuantity: totalTradingQuantity,
      executionIntent,
    });
    const rawMarket: any = market;
    const marketData: any = rawMarket?.data !== undefined ? rawMarket.data : rawMarket;
    if (rawMarket.rateLimited) applyUpstoxBackoff(rawMarket.retryAfterMs);
    if (!marketData)
      throw new Error(
        [rawMarket.error, rawMarket.details].filter(Boolean).join(" — ") || "Upstox market data is temporarily unavailable.",
      );
    setSystemStatus((prev) => ({
      ready: prev?.gemini?.ok ? true : (prev?.ready ?? true),
      upstox: {
        ok: true,
        message: rawMarket.fallback
          ? "Upstox rate-limited; using last cached market data while waiting 5 seconds."
          : "Upstox token verified by live market data fetch.",
      },
      gemini: prev?.gemini ?? { ok: false, message: "Run Re-test OpenAI to confirm OpenAI API status." },
      checkedAt: new Date().toISOString(),
    }));
    // Normalize: VPS may return raw quote map keyed by "NSE_INDEX:Nifty 50" (or "|" variant)
    const rawData: any = marketData;
    const niftyNode =
      rawData?.["NSE_INDEX:Nifty 50"] ||
      rawData?.["NSE_INDEX|Nifty 50"] ||
      (rawData && typeof rawData === "object"
        ? (Object.values(rawData).find(
            (v: any) => v && typeof v === "object" && (v.last_price ?? v.ltp) != null,
          ) as any)
        : null);
    // Map new VPS snake_case response into legacy raw_payload shape so all UI bindings keep working.
    let value = Number(rawData?.spot_ltp ?? rawData?.ltp);
    if (!Number.isFinite(value)) value = Number(niftyNode?.last_price ?? niftyNode?.ltp);
    const availableCash =
      rawData?.available_cash ??
      rawData?.raw_payload?.account?.margin?.availableCash ??
      rawData?.account?.margin?.availableCash ??
      rawData?.funds?.equity?.available_margin;
    const todayPnl = rawData?.today_pnl ?? rawData?.raw_payload?.account?.todayPnl;
    const ceLtpFlat = Number(rawData?.atm_ce_ltp);
    const peLtpFlat = Number(rawData?.atm_pe_ltp);
    const atmStrikeFlat = Number(rawData?.atm_strike);
    const indiaVixFlat = Number(rawData?.indiaVix ?? rawData?.india_vix);
    rawData.raw_payload = rawData.raw_payload ?? {};
    rawData.raw_payload.account = rawData.raw_payload.account ?? {};
    rawData.raw_payload.account.margin = rawData.raw_payload.account.margin ?? {};
    if (availableCash != null) rawData.raw_payload.account.margin.availableCash = availableCash;
    if (todayPnl != null) rawData.raw_payload.account.todayPnl = todayPnl;
    rawData.raw_payload.context = rawData.raw_payload.context ?? {};
    const atmCtx: any = rawData.raw_payload.context.atm ?? {};
    if (Number.isFinite(atmStrikeFlat)) atmCtx.strike = atmStrikeFlat;
    if (Number.isFinite(ceLtpFlat) || rawData?.ce_symbol || rawData?.ce_instrument_token) {
      atmCtx.ce = {
        ...(atmCtx.ce || {}),
        ltp: Number.isFinite(ceLtpFlat) ? ceLtpFlat : atmCtx.ce?.ltp,
        strike: Number.isFinite(atmStrikeFlat) ? atmStrikeFlat : atmCtx.ce?.strike,
        symbol: rawData?.ce_symbol ?? atmCtx.ce?.symbol,
        instrument_token: rawData?.ce_instrument_token ?? atmCtx.ce?.instrument_token,
      };
    }
    if (Number.isFinite(peLtpFlat) || rawData?.pe_symbol || rawData?.pe_instrument_token) {
      atmCtx.pe = {
        ...(atmCtx.pe || {}),
        ltp: Number.isFinite(peLtpFlat) ? peLtpFlat : atmCtx.pe?.ltp,
        strike: Number.isFinite(atmStrikeFlat) ? atmStrikeFlat : atmCtx.pe?.strike,
        symbol: rawData?.pe_symbol ?? atmCtx.pe?.symbol,
        instrument_token: rawData?.pe_instrument_token ?? atmCtx.pe?.instrument_token,
      };
    }
    rawData.raw_payload.context.atm = atmCtx;
    if (Number.isFinite(indiaVixFlat)) {
      rawData.raw_payload.context.indiaVix = {
        ...(rawData.raw_payload.context.indiaVix || {}),
        ltp: indiaVixFlat,
      };
    }
    // BankNifty
    const bankNiftyFlat = Number(rawData?.bankNifty ?? rawData?.bank_nifty);
    if (Number.isFinite(bankNiftyFlat)) {
      rawData.raw_payload.context.bankNifty = {
        ...(rawData.raw_payload.context.bankNifty || {}),
        ltp: bankNiftyFlat,
      };
    }
    // PCR
    const pcrFlat = Number(rawData?.PCR ?? rawData?.pcr);
    if (Number.isFinite(pcrFlat)) {
      rawData.raw_payload.optionChain = {
        ...(rawData.raw_payload.optionChain || {}),
        pcr: pcrFlat,
      };
    }
    // Heavyweights
    if (rawData?.heavyweights) {
      rawData.raw_payload.context.heavyweights = rawData.heavyweights;
    }
    // ATM expiry
    if (rawData?.atm_expiry) {
      atmCtx.expiry = rawData.atm_expiry;
      rawData.raw_payload.context.atm = atmCtx;
    }
    // Inject normalized fields so downstream UI bindings work uniformly
    if (Number.isFinite(value)) {
      rawData.ltp = value;
      rawData.source_timestamp = rawData.source_timestamp ?? new Date().toISOString();
    }
    console.log("LIVE RESPONSE", market);
    console.log("[REST] fetch-nifty-data payload:", rawData);
    console.log("[REST] parsed LTP:", value, "availableCash:", availableCash);
    setLatestData(rawData);
    if (Number.isFinite(value)) {
      const timestamp = rawData.source_timestamp ?? rawData.created_at ?? new Date().toISOString();
      setMarketHistory((prev) => {
        const next = [...prev, { value, time: timestamp }].slice(-30);
        console.log("[REST] marketHistory updated, points:", next.length, "latest:", value);
        return next;
      });
      // Update ATM CE/PE rolling series; reset when strike changes
      const atm = (rawData?.raw_payload as any)?.context?.atm;
      const ceLtp = Number(atm?.ce?.ltp);
      const peLtp = Number(atm?.pe?.ltp);
      const ceStrike = Number(atm?.ce?.strike ?? atm?.strike);
      const peStrike = Number(atm?.pe?.strike ?? atm?.strike);
      if (Number.isFinite(ceStrike) && ceStrikeRef.current !== ceStrike) {
        ceStrikeRef.current = ceStrike;
        setCeSeries([]);
      }
      if (Number.isFinite(peStrike) && peStrikeRef.current !== peStrike) {
        peStrikeRef.current = peStrike;
        setPeSeries([]);
      }
      if (Number.isFinite(ceLtp)) setCeSeries((prev) => [...prev, { value: ceLtp, time: timestamp }].slice(-30));
      if (Number.isFinite(peLtp)) setPeSeries((prev) => [...prev, { value: peLtp, time: timestamp }].slice(-30));
      // Force a fresh AI cycle when price moves >15pts from anchor (re-baseline immediate S/R reasoning)
      const anchor = levelsAnchorLtpRef.current;
      if (anchor === null) levelsAnchorLtpRef.current = value;
      else if (
        Math.abs(value - anchor) > 15 &&
        aiEnabled &&
        !tradingBlocked &&
        Date.now() - lastForcedAiAtRef.current > 15_000
      ) {
        levelsAnchorLtpRef.current = value;
        lastForcedAiAtRef.current = Date.now();
        runTradingCycle().catch(() => {});
      }
    }
    return rawData;
  };

  const checkSystemStatus = async (showToast = true) => {
    setIsCheckingStatus(true);
    try {
      const savedSession = await restoreSavedUpstoxSession().catch(() => null);
      // Upstox token lives on VPS settings.json; OpenAI key lives in Supabase.
      // Query each in its own home and merge into one SystemStatus payload.
      const [upstoxRes, openaiRes] = await Promise.allSettled([
        invokeFunction<UpstoxStatus>("system-status", { target: "upstox" }),
        invokeFunction<OpenAIStatus>("system-status", { target: "openai" }),
      ]);
      let upstox =
        upstoxRes.status === "fulfilled"
          ? upstoxRes.value.upstox
          : {
              ok: false,
              message: upstoxRes.reason instanceof Error ? upstoxRes.reason.message : "Upstox check failed.",
            };
      if (getStatusEndpointMethod(vpsStatusEndpoint) === "GET") {
        upstox = savedSession?.upstox?.ok
          ? savedSession.upstox
          : { ok: false, message: "VPS tunnel is reachable, but no saved Upstox access token was found. Complete OAuth once." };
      }
      // Resilience: if a manually configured VPS status route is unavailable (404 / Not Found)
      // but we previously connected successfully (flag in localStorage) and the tunnel
      // is reachable, keep the dashboard in CONNECTED state instead of forcing re-OAuth.
      if (!upstox.ok && localStorage.getItem(UPSTOX_CONNECTED_FLAG_KEY) === "true") {
        const msg = (upstox.message || "").toLowerCase();
        if (msg.includes("not found") || msg.includes("404") || msg.includes("vps 404")) {
          upstox = {
            ok: true,
            message: "Upstox token persisted on VPS (status route unavailable, using cached state).",
          };
        }
      }
      if (!upstox.ok) {
        const restored = await restoreSavedUpstoxSession().catch(() => null);
        if (restored?.upstox?.ok) upstox = restored.upstox;
      }
      if (upstox.ok) localStorage.setItem(UPSTOX_CONNECTED_FLAG_KEY, "true");
      const gemini =
        openaiRes.status === "fulfilled"
          ? openaiRes.value.gemini
          : {
              ok: false,
              message: openaiRes.reason instanceof Error ? openaiRes.reason.message : "OpenAI check failed.",
            };
      const status: SystemStatus = {
        ready: upstox.ok && gemini.ok,
        upstox,
        gemini,
        checkedAt: new Date().toISOString(),
      };
      setSystemStatus(status);
      if (showToast) {
        const failures = [status.upstox, status.gemini]
          .filter((item) => !item.ok)
          .map((item) => item.message)
          .join(" ");
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
      const savedSession = await restoreSavedUpstoxSession().catch(() => null);
      const status = getStatusEndpointMethod(vpsStatusEndpoint) === "GET"
        ? savedSession ?? {
            upstox: { ok: false, message: "No saved Upstox access token found in backend storage. Complete OAuth once." },
            checkedAt: new Date().toISOString(),
          }
        : await invokeFunction<UpstoxStatus>("system-status", { target: "upstox" });
      setSystemStatus((prev) => {
        const gemini = prev?.gemini ?? { ok: false, message: "Run Re-test OpenAI to confirm OpenAI API status." };
        return { ready: status.upstox.ok && gemini.ok, upstox: status.upstox, gemini, checkedAt: status.checkedAt };
      });
      if (showToast)
        toast({
          title: status.upstox.ok ? "Upstox verified" : "Upstox needs OAuth",
          description: status.upstox.message,
          variant: status.upstox.ok ? "default" : "destructive",
        });
      return status;
    } catch (error) {
      if (showToast)
        toast({
          title: "Upstox re-test failed",
          description: error instanceof Error ? error.message : "Unable to test Upstox.",
          variant: "destructive",
        });
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
      if (showToast)
        toast({
          title: status.gemini.ok ? "OpenAI connected" : "OpenAI still failing",
          description: status.gemini.message,
          variant: status.gemini.ok ? "default" : "destructive",
        });
      return status;
    } catch (error) {
      if (showToast)
        toast({
          title: "OpenAI re-test failed",
          description: error instanceof Error ? error.message : "Unable to test OpenAI.",
          variant: "destructive",
        });
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
    const ai = await withTimeout(
      invokeFunction<{ signal: Signal }>("analyze-with-ai", {
        tradingMode,
        tradingLotSize: normalizedTradingLotSize,
        dailyProfitTarget: normalizedDailyTarget,
        maxDailyLoss: normalizedMaxDailyLoss,
        dailyPnl,
        userTargetPoints: Number(userTargetPoints) || null,
        userSlPoints: Number(userSlPoints) || null,
      }),
      25_000,
      "OpenAI analysis timed out; continuing Upstox polling.",
    );
    applySniperSignal(ai.signal);
  };

  const executeTradingSignal = async () => {
    setIsBusy(true);
    try {
      if (!upstoxReady) {
        const status = await retestUpstox(true);
        if (!status.upstox.ok) return;
      }
      if (tradingBlocked) {
        toast({
          title: cooldownActive
            ? "Cooldown Active"
            : targetAchieved
              ? "Target Achieved"
              : hardKillActive
                ? "Hard Kill-Switch Active"
                : "Max Trades Reached",
          description: cooldownActive
            ? `Next entry allowed in ${cooldownRemainingMinutes} min.`
            : "Trading activity is stopped for the day.",
          variant: targetAchieved || cooldownActive ? "default" : "destructive",
        });
        return;
      }

      // ===== SIGNAL LOCK: use locked signal, do NOT re-call AI =====
      const locked = signalLockRef.current;
      const lockedSignal: Signal | null =
        locked?.signal && isTradeSignal(locked.signal.action)
          ? locked.signal
          : latestSignal && isTradeSignal(latestSignal.action)
            ? latestSignal
            : null;

      if (!lockedSignal) {
        toast({
          title: "No active signal",
          description: "Wait for a BUY/SELL signal before executing.",
          variant: "destructive",
        });
        return;
      }

      // Optional staleness check (do NOT auto-cancel; warn user)
      const sigTs = locked?.lockedUntil
        ? locked.lockedUntil - SIGNAL_LOCK_MS
        : Date.parse(lockedSignal.created_at ?? "") || Date.now();
      const sigAgeMs = Date.now() - sigTs;
      if (sigAgeMs > SIGNAL_STALE_MS) {
        const ok =
          typeof window !== "undefined"
            ? window.confirm(`Signal is ${Math.round(sigAgeMs / 1000)}s old. Execute anyway?`)
            : true;
        if (!ok) return;
      }

      pushDebug({
        stage: "SIGNAL",
        level: "info",
        title: "Executing locked signal...",
        detail: `${lockedSignal.action} ${lockedSignal.strike}`,
        data: { ageMs: sigAgeMs },
      });
      toast({ title: "Executing locked signal...", description: `${lockedSignal.action} ${lockedSignal.strike}` });

      const liveMarket = await fetchLiveNifty(true, true);
      const liveSpot = Number(liveMarket?.ltp);
      const ai = { signal: lockedSignal };

      if (!Number.isFinite(liveSpot)) {
        toast({
          title: "Live price missing",
          description: "Cannot place a live order until Nifty spot is available.",
          variant: "destructive",
        });
        return;
      }
      const liveAvailableCash = toNumber(liveMarket?.raw_payload?.account?.margin?.availableCash) ?? availableCash;
      if (liveAvailableCash <= 0) {
        toast({
          title: "Low Margin",
          description: "Available Cash from Upstox is zero or unavailable. Live order blocked.",
          variant: "destructive",
        });
        return;
      }
      const suggestedStrike = parseSuggestedStrike(ai.signal.strike);
      const orderPayload = {
        action: ai.signal.action,
        spotPrice: liveSpot,
        strike: suggestedStrike ?? undefined,
        tradingLotSize: normalizedTradingLotSize,
        effectiveLotSize: ai.signal.effectiveLotSize,
        targetPremiumPoints: DEFAULT_PREMIUM_TARGET_POINTS,
        stopLossPremiumPoints: DEFAULT_PREMIUM_SL_POINTS,
        maxSlippagePct: execSettings.slippagePct,
        riskPoints: (ai.signal as any).riskPoints ?? undefined,
        rrMultiplier: (ai.signal as any).rrMultiplier ?? undefined,
      };
      pushDebug({
        stage: "ORDER",
        level: "info",
        title: "ORDER PLACING",
        detail: `${ai.signal.action} ${suggestedStrike ?? "ATM"} · spot ${liveSpot.toFixed(2)}`,
        data: orderPayload,
      });
      const liveOrder = await invokeFunction<LiveOrderResult>("place-live-order", orderPayload);
      setLastExecution(liveOrder);
      if (!liveOrder.success) {
        pushDebug({
          stage: "ERROR",
          level: "error",
          title: "ORDER FAILED",
          detail: `${liveOrder.error ?? "blocked"} — ${liveOrder.details ?? ""}`,
          data: { execution: liveOrder.execution, slippage: liveOrder.slippage, liquidity: liveOrder.liquidity },
        });
        toast({
          title: liveOrder.error ?? "Live order blocked",
          description: liveOrder.details ?? "Available Cash is insufficient for the selected lot size.",
          variant: "destructive",
        });
        return;
      }
      pushDebug({
        stage: "ORDER",
        level: "success",
        title: "ORDER PLACED",
        detail: `${liveOrder.instrument.tradingSymbol} · qty ${liveOrder.quantity}`,
        data: {
          orderId: (liveOrder as any).order?.data?.order_id ?? (liveOrder as any).order?.order_id,
          instrument: liveOrder.instrument,
        },
      });
      if (liveOrder.execution?.orderFilled) {
        pushDebug({
          stage: "FILL",
          level: "success",
          title: "ORDER FILLED",
          detail: `Fill ₹${liveOrder.entryPremium?.toFixed(2)} · slippage ${liveOrder.slippage?.slippagePct?.toFixed(2) ?? "—"}%`,
          data: {
            fillPrice: liveOrder.entryPremium,
            quotedLtp: liveOrder.slippage?.quotedLtp,
            quantity: liveOrder.quantity,
            status: liveOrder.execution?.orderStatus,
          },
        });
      } else {
        pushDebug({
          stage: "FILL",
          level: "warn",
          title: "ORDER PENDING",
          detail: `Status ${liveOrder.execution?.orderStatus ?? "unknown"}`,
        });
      }
      if (liveOrder.execution?.slActive) {
        pushDebug({
          stage: "SL",
          level: "success",
          title: "SL ACTIVE",
          detail: `Trigger ₹${liveOrder.slTriggerPrice?.toFixed(2) ?? "—"} · Limit ₹${liveOrder.slLimitPrice?.toFixed(2) ?? "—"}`,
          data: { slType: liveOrder.slType, slOrderId: liveOrder.slOrderId },
        });
      } else {
        pushDebug({
          stage: "ERROR",
          level: "warn",
          title: "SL FAILED",
          detail: "Server SL was not registered. Manual exit required if filled.",
        });
      }
      const shouldUseManualExitPrices =
        suggestedEntryPremium !== null && Math.abs(suggestedEntryPremium - liveOrder.entryPremium) <= 1;
      const targetPremium =
        shouldUseManualExitPrices && Number(userTargetPoints) ? Number(userTargetPoints) : liveOrder.targetPremium;
      const stopLossPremium =
        shouldUseManualExitPrices && Number(userSlPoints) ? Number(userSlPoints) : liveOrder.stopLossPremium;
      const targetPoints = Math.abs(targetPremium - liveOrder.entryPremium);
      const slPoints = Math.abs(liveOrder.entryPremium - stopLossPremium);
      const plan: NonNullable<ActiveTradePlan> = {
        action: ai.signal.action as "BUY" | "SELL",
        entry: liveSpot,
        target: targetPremium,
        stopLoss: stopLossPremium,
        strike: liveOrder.instrument.tradingSymbol,
        quantity: liveOrder.quantity,
        initialTargetPoints: targetPoints,
        initialSlPoints: slPoints,
        instrumentToken: liveOrder.instrumentToken,
        slOrderId: liveOrder.slOrderId,
        entryPremium: liveOrder.entryPremium,
        currentPremium: liveOrder.entryPremium,
        targetPremium,
        stopLossPremium,
        lastSyncedStopLossPremium: liveOrder.stopLossPremium,
      };
      if (!userEditedExitsRef.current) {
        setUserTargetPoints(formatPremiumInput(targetPremium));
        setUserSlPoints(formatPremiumInput(stopLossPremium));
      }
      const nextCount = Math.min(MAX_TRADES_PER_DAY, executedTrades + 1);
      setExecutedTrades(nextCount);
      setActiveTrade(true);
      setActiveTradePlan(plan);
      localStorage.setItem(TRADE_COUNT_STORAGE_KEY, `${todayKey()}:${nextCount}`);
      localStorage.setItem(ACTIVE_TRADE_STORAGE_KEY, `${todayKey()}:true`);
      localStorage.setItem(ACTIVE_TRADE_PLAN_STORAGE_KEY, `${todayKey()}:${JSON.stringify(plan)}`);
      toast({
        title: "LIVE ORDER + SERVER SL PLACED",
        description: `${liveOrder.instrument.tradingSymbol} · Entry ₹${liveOrder.entryPremium.toFixed(2)} · SL ₹${liveOrder.stopLossPremium.toFixed(2)}.`,
      });
      return;
    } catch (error) {
      pushDebug({
        stage: "ERROR",
        level: "error",
        title: "ORDER FAILED",
        detail: error instanceof Error ? error.message : String(error),
      });
      toast({
        title: "Live execution failed",
        description: error instanceof Error ? error.message : "Execution cycle will retry on the next poll.",
        variant: "destructive",
      });
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
      toast({
        title: lockForDay ? "Emergency exit + lock active" : "Emergency exit sent",
        description: "Open positions exit request was sent to Upstox. New entries are blocked for 15 minutes.",
      });
    } catch (error) {
      toast({
        title: "Emergency exit failed",
        description: error instanceof Error ? error.message : "Please check Upstox and retry.",
        variant: "destructive",
      });
    } finally {
      setIsBusy(false);
    }
  };

  const toggleAiTrading = async (checked: boolean) => {
    if (checked && tradingBlocked) {
      toast({
        title: cooldownActive
          ? "Cooldown Active"
          : targetAchieved
            ? "Target Achieved"
            : hardKillActive
              ? "Hard Kill-Switch Active"
              : "Max Trades Reached",
        description: cooldownActive
          ? `AI entry blocked for ${cooldownRemainingMinutes} more minutes.`
          : "AI trading is disabled for the rest of the day.",
        variant: targetAchieved || cooldownActive ? "default" : "destructive",
      });
      return;
    }
    setIsBusy(true);
    localStorage.setItem(AI_ARMED_STORAGE_KEY, String(checked));
    try {
      await invokeFunction("toggle-ai-trading", {
        isActive: checked,
        riskMode,
        tradingLotSize: normalizedTradingLotSize,
        tradingQuantity: totalTradingQuantity,
      });
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
      toast({
        title: checked ? "AI trading loop started" : "AI trading loop stopped",
        description: checked
          ? "Upstox market polling runs every 5 seconds; OpenAI reasoning runs every 30 seconds while this page is open."
          : "Automation is paused.",
      });

      // Sync FastAPI backend mode (AUTO when armed, MANUAL when off)
      // NOTE: AI/autotrade endpoint failure must NOT mark backend offline.
      // VPS online status is determined solely by /fetch-nifty-data success.
      try {
        const target = checked ? "auto" : "manual";
        const result = await syncFastApiMode(target, normalizedVpsBaseUrl);
        const m = (result.mode || "").toUpperCase();
        if (m === "AUTO" || m === "MANUAL") setBackendMode(m);
        toast({
          title: checked ? "AUTO MODE ENABLED" : "MANUAL MODE ENABLED",
          description: `Backend status: ${result.status}`,
        });
      } catch (err) {
        // Do NOT flip backendOnline here — market polling owns that signal.
        setBackendMode("UNKNOWN");
        toast({
          title: "AI Engine Not Configured",
          description: err instanceof Error ? err.message : "AI/autotrade endpoint unreachable. Market data polling continues.",
          variant: "default",
        });
      }
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
    if (session) {
      const pollMarket = async () => {
        if (marketPollInFlightRef.current) return;
        marketPollInFlightRef.current = true;
        try {
          await fetchLiveNifty();
          // Backend online status depends ONLY on /fetch-nifty-data success.
          setBackendOnline(true);
        } catch (error) {
          setBackendOnline(false);
          showRetryToast(error instanceof Error ? error.message : "Unable to fetch Upstox market data.");
        } finally {
          marketPollInFlightRef.current = false;
        }
      };
      pollMarket();
      marketIntervalRef.current = setInterval(pollMarket, UPSTOX_POLL_INTERVAL_MS);
    }
    return () => {
      if (marketIntervalRef.current) clearInterval(marketIntervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, normalizedTradingLotSize, totalTradingQuantity, normalizedVpsBaseUrl]);

  useEffect(() => {
    if (aiIntervalRef.current) clearInterval(aiIntervalRef.current);
    if (session && aiEnabled) {
      aiIntervalRef.current = setInterval(() => {
        if (tradingBlocked) return;
        withTimeout(
          invokeFunction<{ signal: Signal }>("analyze-with-ai", {
            tradingMode,
            tradingLotSize: normalizedTradingLotSize,
            dailyProfitTarget: normalizedDailyTarget,
            maxDailyLoss: normalizedMaxDailyLoss,
            dailyPnl,
            userTargetPoints: Number(userTargetPoints) || null,
            userSlPoints: Number(userSlPoints) || null,
          }),
          25_000,
          "OpenAI analysis timed out; continuing Upstox polling.",
        )
          .then((ai) => applySniperSignal(ai.signal))
          .catch((error) =>
            showRetryToast(error instanceof Error ? error.message : "OpenAI reasoning will retry on the next 30-second poll."),
          );
      }, AI_REASONING_INTERVAL_MS);
    }
    return () => {
      if (aiIntervalRef.current) clearInterval(aiIntervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    session,
    aiEnabled,
    tradingBlocked,
    normalizedTradingLotSize,
    normalizedDailyTarget,
    normalizedMaxDailyLoss,
    dailyPnl,
    userTargetPoints,
    userSlPoints,
  ]);

  useEffect(() => {
    if (!session) return;
    resetDailyTradeQuota();
    restoreSavedUpstoxSession()
      .catch(() => null)
      .then(() => checkSystemStatus(false))
      .then(() => null)
      .catch(() => {
        // Connection Pulse will show missing setup after a manual check.
      });
    if (aiEnabled && !marketIsOpen) setAiEnabled(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // AUTO-TRADE MODE: when a high-probability BUY/SELL signal arrives, fire the order immediately.
  useEffect(() => {
    if (!autoTradeMode || !aiEnabled) return;
    if (!latestSignal || !highProbabilitySignal) return;
    if (!isTradeSignal(latestSignal.action)) return;
    if (activeTrade || tradingBlocked || isBusy || !upstoxReady) return;
    const key = `${latestSignal.created_at ?? ""}-${latestSignal.action}-${latestSignal.strike}`;
    if (lastAutoFiredSignalRef.current === key) return;
    lastAutoFiredSignalRef.current = key;
    toast({ title: "AUTO-TRADE FIRING", description: `${latestSignal.action} ${latestSignal.strike}` });
    executeTradingSignal().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestSignal, highProbabilitySignal, autoTradeMode, aiEnabled, activeTrade, tradingBlocked, isBusy, upstoxReady]);

  return (
    <main
      className={`min-h-screen overflow-hidden bg-terminal text-foreground ${exitAlertActive ? "animate-pulse bg-loss" : ""}`}
    >
      <div className="pointer-events-none fixed inset-0 noise-overlay opacity-30" />
      <section className="relative mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-4 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 rounded-lg border border-border bg-panel/80 p-4 shadow-panel backdrop-blur md:flex-row md:items-center md:justify-between">
          <div>
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.28em] text-muted-foreground">
              <Radio className="h-3.5 w-3.5 text-primary" /> Options Command Desk
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-normal text-foreground sm:text-3xl">
              Nifty Options Trading Dashboard
            </h1>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:min-w-[430px]">
            <div className="rounded-md border border-border bg-surface px-4 py-3">
              <p className="text-xs uppercase text-muted-foreground">Live Nifty 50</p>
              <div className="mt-1 flex items-end gap-2">
                <span className="text-2xl font-bold text-foreground">
                  {hasLivePrice ? latestLtp.toLocaleString("en-IN") : "—"}
                </span>
                <span className="flex items-center text-sm font-semibold text-profit">
                  <TrendingUp className="h-4 w-4" /> {hasLivePrice ? "Live" : "Waiting"}
                </span>
              </div>
            </div>
            <div className="rounded-md border border-primary/30 bg-primary/10 px-4 py-3">
              <p className="text-xs uppercase text-muted-foreground">Connection Status</p>
              <div className={`mt-2 flex items-center gap-2 text-sm font-semibold ${connectionTone}`}>
                <span className={`h-2.5 w-2.5 rounded-full ${connectionDot} animate-pulse-glow`} /> {connectionLabel}
              </div>
              <div className="mt-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.16em]">
                <span
                  className={`inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 font-semibold ${backendOnline === false ? "border-loss/40 bg-loss/10 text-loss" : backendOnline ? "border-profit/40 bg-profit/10 text-profit" : "border-border bg-surface text-muted-foreground"}`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${backendOnline === false ? "bg-loss" : backendOnline ? "bg-profit" : "bg-muted-foreground"}`}
                  />
                  {backendOnline === false ? "Backend Offline" : backendOnline ? "Backend Online" : "Backend ?"}
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-surface px-1.5 py-0.5 font-semibold text-foreground">
                  Mode: {backendMode}
                </span>
                <span
                  title={systemStatus?.upstox?.message ?? "Upstox OAuth status"}
                  className={`inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 font-semibold ${
                    upstoxReady
                      ? "border-profit/40 bg-profit/10 text-profit"
                      : upstoxNeedsSetup
                        ? "border-loss/40 bg-loss/10 text-loss"
                        : "border-border bg-surface text-muted-foreground"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      upstoxReady ? "bg-profit" : upstoxNeedsSetup ? "bg-loss" : "bg-muted-foreground"
                    }`}
                  />
                  Upstox: {upstoxReady ? "Connected" : upstoxNeedsSetup ? "Not Connected" : "—"}
                </span>
                <span
                  title={`VPS tunnel: ${normalizedVpsBaseUrl}`}
                  className={`inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 font-semibold ${
                    tunnelOnline
                      ? "border-profit/40 bg-profit/10 text-profit"
                      : tunnelOnline === false
                        ? "border-loss/40 bg-loss/10 text-loss"
                        : "border-border bg-surface text-muted-foreground"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      tunnelOnline
                        ? "bg-profit animate-pulse"
                        : tunnelOnline === false
                          ? "bg-loss"
                          : "bg-muted-foreground"
                    }`}
                  />
                  {tunnelOnline ? "VPS TUNNEL ACTIVE" : tunnelOnline === false ? "VPS TUNNEL DOWN" : "VPS TUNNEL ?"}
                </span>
              </div>
            </div>
            <div className="rounded-md border border-border bg-surface px-4 py-3">
              <p className="text-xs uppercase text-muted-foreground">Available Cash</p>
              <p className="mt-1 text-2xl font-bold text-profit">
                {formatMoney(latestData?.raw_payload?.account?.margin?.availableCash)}
              </p>
            </div>
            <div className="rounded-md border border-border bg-surface px-4 py-3">
              <p className="text-xs uppercase text-muted-foreground">Today's P&L</p>
              <p className={`mt-1 text-2xl font-bold ${dailyPnl >= 0 ? "text-profit" : "text-loss"}`}>
                {formatMoney(dailyPnl)}
              </p>
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
            <div className="mb-4 flex items-center gap-2">
              <LogIn className="h-5 w-5 text-primary" />
              <h2 className="text-xl font-semibold">Secure Access</h2>
            </div>
            <form onSubmit={signIn} className="grid gap-3 md:grid-cols-[1fr_1fr_auto_auto]">
              <Input
                type="email"
                placeholder="Email"
                value={authEmail}
                onChange={(event) => setAuthEmail(event.target.value)}
                required
                className="border-border bg-surface"
              />
              <Input
                type="password"
                placeholder="Password"
                value={authPassword}
                onChange={(event) => setAuthPassword(event.target.value)}
                required
                minLength={8}
                className="border-border bg-surface"
              />
              <Button type="submit" variant="trading">
                Sign in
              </Button>
              <Button type="button" variant="terminal" onClick={signInWithGoogle}>
                Google
              </Button>
            </form>
          </section>
        )}

        <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
          <DialogContent className="h-dvh w-screen max-w-none overflow-y-auto rounded-none border-border bg-panel text-foreground shadow-panel sm:h-auto sm:max-h-[92vh] sm:max-w-2xl sm:rounded-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-xl">
                <KeyRound className="h-5 w-5 text-primary" /> API Settings
              </DialogTitle>
              <DialogDescription>
                Keys are submitted only to the secure backend function and are cleared from this form after saving.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={saveOpenAISettings} className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="upstox-api-key" className="flex items-center gap-2">
                    Upstox API Key{" "}
                    {systemStatus?.upstox?.ok && (
                      <CheckCircle2 className="h-4 w-4 text-profit" aria-label="Upstox verified" />
                    )}
                  </Label>
                  <Input
                    id="upstox-api-key"
                    type="text"
                    autoComplete="off"
                    placeholder="Enter Upstox API Key"
                    value={settings.upstoxApiKey}
                    onChange={(event) => setSettings((prev) => ({ ...prev, upstoxApiKey: event.target.value }))}
                    className="border-border bg-surface"
                  />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="upstox-api-secret" className="flex items-center gap-2">
                    Upstox API Secret{" "}
                    {systemStatus?.upstox?.ok && (
                      <CheckCircle2 className="h-4 w-4 text-profit" aria-label="Upstox verified" />
                    )}
                  </Label>
                  <Input
                    id="upstox-api-secret"
                    type="text"
                    autoComplete="off"
                    placeholder="Enter Upstox API Secret"
                    value={settings.upstoxApiSecret}
                    onChange={(event) => setSettings((prev) => ({ ...prev, upstoxApiSecret: event.target.value }))}
                    className="border-border bg-surface"
                  />
                </div>
                <div className="space-y-2 sm:col-span-2 rounded-md border border-primary/30 bg-primary/5 p-3">
                  <Label htmlFor="manual-access-token" className="flex items-center gap-2">
                    Permanent Access Token
                    <span className="text-[10px] font-normal text-muted-foreground">(bypasses OAuth)</span>
                  </Label>
                  <Input
                    id="manual-access-token"
                    type="text"
                    autoComplete="off"
                    placeholder="Paste your permanent Upstox access token"
                    value={settings.manualAccessToken}
                    onChange={(event) => setSettings((prev) => ({ ...prev, manualAccessToken: event.target.value }))}
                    className="border-border bg-surface font-mono text-xs"
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs leading-5 text-muted-foreground">
                      Saved to backend &amp; VPS. Status flips to CONNECTED immediately.
                    </p>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={isBusy}
                        onClick={clearSavedSession}
                      >
                        Clear Saved Session
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="trading"
                        disabled={isBusy || !settings.manualAccessToken.trim()}
                        onClick={saveManualAccessToken}
                      >
                        Save Token
                      </Button>
                    </div>
                  </div>
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="openai-api-key" className="flex items-center gap-2">
                    OpenAI API Key{" "}
                    {systemStatus?.gemini?.ok && (
                      <CheckCircle2 className="h-4 w-4 text-profit" aria-label="OpenAI verified" />
                    )}
                  </Label>
                  <Input
                    id="openai-api-key"
                    type="text"
                    autoComplete="off"
                    placeholder="Enter OpenAI API Key"
                    value={settings.openaiApiKey}
                    onChange={(event) => setSettings((prev) => ({ ...prev, openaiApiKey: event.target.value }))}
                    className="border-border bg-surface"
                  />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="vps-tunnel-url">VPS Tunnel URL</Label>
                  <Input
                    id="vps-tunnel-url"
                    type="url"
                    autoComplete="off"
                    placeholder="https://size-exams-mono-skill.trycloudflare.com"
                    value={vpsTunnelUrl}
                    onChange={(event) => setVpsTunnelUrl(event.target.value)}
                    className="border-border bg-surface"
                  />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="vps-status-endpoint">Status Endpoint (path on VPS)</Label>
                  <Input
                    id="vps-status-endpoint"
                    type="text"
                    autoComplete="off"
                    placeholder="/"
                    value={vpsStatusEndpoint}
                    onChange={(e) => setVpsStatusEndpoint(normalizeStatusEndpoint(e.target.value))}
                    className="border-border bg-surface"
                  />
                  <p className="text-xs leading-5 text-muted-foreground">
                    Default uses <span className="text-foreground">/</span> with GET. Use{" "}
                    <span className="text-foreground">/fetch-data</span> if that is your VPS health/data route.
                  </p>
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="redirect-uri">Manual Redirect URI from Upstox Developer Portal</Label>
                  <Input
                    id="redirect-uri"
                    type="url"
                    autoComplete="off"
                    placeholder={upstoxOAuthRedirectUri}
                    value={settings.redirectUri}
                    onChange={(event) => {
                      setRedirectUriManuallyEdited(true);
                      setSettings((prev) => ({ ...prev, redirectUri: event.target.value }));
                    }}
                    className="border-border bg-surface"
                  />
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs leading-5 text-muted-foreground">
                      Get Code uses this exact value. Encoded:{" "}
                      <span className="text-foreground break-all">
                        {encodeURIComponent(settings.redirectUri || upstoxOAuthRedirectUri)}
                      </span>
                    </p>
                    {redirectUriManuallyEdited && (
                      <button
                        type="button"
                        className="shrink-0 text-xs text-primary underline"
                        onClick={() => {
                          setRedirectUriManuallyEdited(false);
                          setSettings((prev) => ({ ...prev, redirectUri: upstoxOAuthRedirectUri }));
                        }}
                      >
                        Reset to auto
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <div className="rounded-md border border-border bg-surface p-2 text-xs">
                <div className="text-muted-foreground">
                  VPS: <span className="text-foreground break-all">{normalizedVpsBaseUrl}</span>
                </div>
                <div
                  className={
                    vpsSaveStatus?.ok
                      ? "text-emerald-500"
                      : vpsSaveStatus
                        ? "text-destructive"
                        : "text-muted-foreground"
                  }
                >
                  Last save:{" "}
                  {vpsSaveStatus ? `${vpsSaveStatus.ok ? "OK" : "FAIL"} – ${vpsSaveStatus.message}` : "not yet"}
                </div>
              </div>
              <DialogFooter className="gap-2 sm:justify-between sm:space-x-0">
                <Button
                  disabled={isBusy}
                  type="button"
                  variant="terminal"
                  onClick={startUpstoxOAuth}
                >
                  <ExternalLink className="h-4 w-4" /> Get Code
                </Button>
                <Button
                  disabled={isBusy || !settings.upstoxApiKey || !settings.upstoxApiSecret}
                  type="button"
                  variant="terminal"
                  onClick={saveUpstoxSettings}
                >
                  Save Upstox
                </Button>
                <Button disabled={isBusy || !settings.openaiApiKey} type="submit" variant="trading">
                  Save OpenAI
                </Button>
              </DialogFooter>
            </form>
            <div className="rounded-md border border-border bg-surface p-3">
              <Label htmlFor="authorization-url" className="text-muted-foreground">
                Authorization URL generated right now
              </Label>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                This is the exact full link returned by the secure backend. Tap Get Code to refresh it, then finish
                login and copy the <span className="font-semibold text-foreground">code</span> from the redirected URL
                bar.
              </p>
              <Textarea
                id="authorization-url"
                readOnly
                value={authorizationUrl || "Tap Get Code to generate the full Upstox Authorization URL."}
                className="mt-2 min-h-[120px] resize-none break-all border-border bg-panel font-mono text-xs"
              />
            </div>
            <div className="rounded-md border border-border bg-surface p-3">
              <Label htmlFor="oauth-code" className="text-muted-foreground">
                Upstox OAuth code
              </Label>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Tap Get Code, finish Upstox login, then copy a fresh{" "}
                <span className="font-semibold text-foreground">code</span> value from the redirected URL bar and paste
                it here.
              </p>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <Input
                  id="oauth-code"
                  placeholder="Paste OAuth code"
                  value={oauthCode}
                  onChange={(event) => setOauthCode(event.target.value)}
                  className="border-border bg-panel"
                />
                <Button disabled={!oauthCode || isBusy} type="button" variant="terminal" onClick={completeUpstoxOAuth}>
                  Connect
                </Button>
              </div>
            </div>
            <div className="rounded-md border border-border bg-surface p-3">
              <Label htmlFor="oauth-debug-log" className="text-muted-foreground">
                Debug Log
              </Label>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                This shows the exact token exchange payload. Generate a fresh OAuth code before tapping Connect again.
              </p>
              <Textarea
                id="oauth-debug-log"
                readOnly
                value={oauthDebugLog}
                className="mt-2 min-h-[96px] resize-none border-border bg-panel font-mono text-xs"
              />
            </div>
          </DialogContent>
        </Dialog>

        {session && (
          <section className="rounded-lg border border-border bg-panel p-5 shadow-panel">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Connection Pulse</p>
                <h2 className="text-xl font-semibold">System Status</h2>
              </div>
              <Button
                type="button"
                variant="terminal"
                disabled={isCheckingStatus}
                onClick={() => checkSystemStatus(true)}
              >
                <RefreshCw className={`h-4 w-4 ${isCheckingStatus ? "animate-spin" : ""}`} /> Verify Now
              </Button>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div
                className={`rounded-md border p-4 ${systemStatus?.upstox?.ok ? "border-profit/30 bg-profit/10" : "border-border bg-surface"}`}
              >
                <div className="mb-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2 font-semibold">
                    {systemStatus?.upstox?.ok ? (
                      <CheckCircle2 className="h-5 w-5 text-profit" />
                    ) : (
                      <XCircle className="h-5 w-5 text-loss" />
                    )}
                    <span>Upstox API Status</span>
                  </div>
                  <Button
                    type="button"
                    variant="terminal"
                    size="sm"
                    disabled={isCheckingStatus}
                    onClick={() => retestUpstox()}
                  >
                    <RefreshCw className={`h-4 w-4 ${isCheckingStatus ? "animate-spin" : ""}`} /> Re-test Upstox
                  </Button>
                </div>
                <p className="text-sm leading-6 text-muted-foreground">
                  {systemStatus?.upstox?.message ?? "Confirms the OAuth access token can reach Upstox right now."}
                </p>
              </div>
              <div
                className={`rounded-md border p-4 ${systemStatus?.gemini?.ok ? "border-profit/30 bg-profit/10" : "border-border bg-surface"}`}
              >
                <div className="mb-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2 font-semibold">
                    {systemStatus?.gemini?.ok ? (
                      <CheckCircle2 className="h-5 w-5 text-profit" />
                    ) : (
                      <XCircle className="h-5 w-5 text-loss" />
                    )}
                    <span>OpenAI GPT-4o Status</span>
                  </div>
                  <Button
                    type="button"
                    variant="terminal"
                    size="sm"
                    disabled={isCheckingStatus}
                    onClick={() => retestOpenAI()}
                  >
                    <RefreshCw className={`h-4 w-4 ${isCheckingStatus ? "animate-spin" : ""}`} /> Re-test OpenAI
                  </Button>
                </div>
                <p className="text-sm leading-6 text-muted-foreground">
                  {systemStatus?.gemini?.message ?? "Runs a small OpenAI GPT-4o response test using the saved key."}
                </p>
              </div>
            </div>
            {systemStatus?.checkedAt && (
              <p className="mt-3 text-xs text-muted-foreground">
                Last checked: {new Date(systemStatus.checkedAt).toLocaleString("en-IN")}
              </p>
            )}
          </section>
        )}

        <div className="grid gap-5 xl:grid-cols-[1.55fr_0.85fr]">
          <section className="relative min-h-[430px] overflow-hidden rounded-lg border border-border bg-panel shadow-panel">
            <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Real-time Upstox feed</p>
                <h2 className="text-xl font-semibold">NIFTY 50 · 1m Live Price</h2>
              </div>
              <div className="flex flex-wrap gap-2 text-xs font-semibold">
                <span className="rounded-sm border border-profit/30 bg-profit/10 px-2 py-1 text-profit">
                  {latestSignal?.action ?? "WAIT"} Bias
                </span>
                <span className="rounded-sm border border-border bg-surface px-2 py-1 text-muted-foreground">
                  Vol:{" "}
                  {latestSignal?.ruleContext?.rules?.volumeValid === true
                    ? "Valid +20%"
                    : latestSignal?.ruleContext?.rules?.volumeValid === false
                      ? "Below +20%"
                      : "Pending"}
                </span>
                <span className="rounded-sm border border-border bg-surface px-2 py-1 text-muted-foreground">
                  VIX: {latestData?.raw_payload?.context?.indiaVix?.ltp ?? "—"}
                </span>
              </div>
            </div>
            <div className="market-grid relative h-[360px] p-5">
              <div className="absolute inset-y-5 right-5 flex flex-col justify-between text-xs text-muted-foreground">
                {chartLevels.map((level, index) => (
                  <span key={`${level}-${index}`}>
                    {marketHistory.length ? level.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : "—"}
                  </span>
                ))}
              </div>
              <div className="absolute left-0 top-1/2 h-px w-full bg-profit/40" />
              <div className="absolute left-0 top-0 h-full w-1/3 bg-gradient-to-r from-primary/10 to-transparent animate-scan motion-reduce:animate-none" />
              {marketHistory.length ? (
                <div className="absolute bottom-8 left-5 right-14 flex h-64 items-end gap-2">
                  {chartBars.map((height, index) => (
                    <div key={`${marketHistory[index].time}-${index}`} className="flex flex-1 items-end justify-center">
                      <span
                        className={`w-full max-w-3 rounded-t-sm ${index > 0 && marketHistory[index].value < marketHistory[index - 1].value ? "bg-loss" : "bg-profit"}`}
                        style={{ height: `${height}%` }}
                      />
                    </div>
                  ))}
                </div>
              ) : Number.isFinite(latestLtp) ? (
                <div className="absolute inset-x-5 bottom-8 right-14 flex h-64 flex-col items-center justify-center gap-2 rounded-md border border-profit/30 bg-surface/70 text-sm">
                  <span className="text-xs uppercase tracking-[0.22em] text-profit">REST polling active</span>
                  <span className="text-3xl font-semibold text-foreground">
                    {latestLtp.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                  </span>
                  <span className="text-xs text-muted-foreground">Live LTP via Upstox REST · websocket idle</span>
                </div>
              ) : (
                <div className="absolute inset-x-5 bottom-8 right-14 flex h-64 items-center justify-center rounded-md border border-border bg-surface/70 text-sm text-muted-foreground">
                  Fetching live Nifty 50 data via REST…
                </div>
              )}
              {chartPolyline && (
                <svg
                  className="absolute bottom-8 left-5 right-14 h-64 w-[calc(100%-5.75rem)] overflow-visible"
                  preserveAspectRatio="none"
                  viewBox="0 0 100 100"
                  aria-hidden="true"
                >
                  <polyline
                    points={chartPolyline}
                    fill="none"
                    stroke="hsl(var(--chart-line))"
                    strokeWidth="1.8"
                    vectorEffect="non-scaling-stroke"
                  />
                  {targetY !== null && targetY >= 0 && targetY <= 100 && (
                    <>
                      <line
                        x1="0"
                        x2="100"
                        y1={targetY}
                        y2={targetY}
                        stroke="hsl(var(--profit))"
                        strokeWidth="1.2"
                        strokeDasharray="3 2"
                        vectorEffect="non-scaling-stroke"
                      />
                      <text
                        x="1"
                        y={Math.max(4, targetY - 1)}
                        fill="hsl(var(--profit))"
                        fontSize="3.2"
                        fontWeight="700"
                      >
                        TGT {visualTargetIndex?.toFixed(1)}
                      </text>
                    </>
                  )}
                  {entryY !== null && entryY >= 0 && entryY <= 100 && signalAction && (
                    <>
                      <line
                        x1="0"
                        x2="100"
                        y1={entryY}
                        y2={entryY}
                        stroke="hsl(var(--primary))"
                        strokeWidth="1"
                        strokeDasharray="2 2"
                        vectorEffect="non-scaling-stroke"
                      />
                      <text x="1" y={Math.max(4, entryY - 1)} fill="hsl(var(--primary))" fontSize="3" fontWeight="700">
                        ENTRY {visualEntryIndex?.toFixed(1)}
                      </text>
                    </>
                  )}
                  {slY !== null && slY >= 0 && slY <= 100 && (
                    <>
                      <line
                        x1="0"
                        x2="100"
                        y1={slY}
                        y2={slY}
                        stroke="hsl(var(--loss))"
                        strokeWidth="1.2"
                        strokeDasharray="3 2"
                        vectorEffect="non-scaling-stroke"
                      />
                      <text x="1" y={Math.max(4, slY - 1)} fill="hsl(var(--loss))" fontSize="3.2" fontWeight="700">
                        SL {visualSlIndex?.toFixed(1)}
                      </text>
                    </>
                  )}
                  {pdhY !== null && (
                    <>
                      <line
                        x1="0"
                        x2="100"
                        y1={pdhY}
                        y2={pdhY}
                        stroke="hsl(var(--warning))"
                        strokeWidth="0.8"
                        strokeDasharray="1 2"
                        vectorEffect="non-scaling-stroke"
                      />
                      <text x="80" y={Math.max(4, pdhY - 1)} fill="hsl(var(--warning))" fontSize="2.6" fontWeight="700">
                        PDH {pdhVal?.toFixed(1)}
                      </text>
                    </>
                  )}
                  {pdlY !== null && (
                    <>
                      <line
                        x1="0"
                        x2="100"
                        y1={pdlY}
                        y2={pdlY}
                        stroke="hsl(var(--warning))"
                        strokeWidth="0.8"
                        strokeDasharray="1 2"
                        vectorEffect="non-scaling-stroke"
                      />
                      <text x="80" y={Math.max(4, pdlY - 1)} fill="hsl(var(--warning))" fontSize="2.6" fontWeight="700">
                        PDL {pdlVal?.toFixed(1)}
                      </text>
                    </>
                  )}
                  {pdcY !== null && (
                    <>
                      <line
                        x1="0"
                        x2="100"
                        y1={pdcY}
                        y2={pdcY}
                        stroke="hsl(var(--muted-foreground))"
                        strokeWidth="0.6"
                        strokeDasharray="0.5 2"
                        vectorEffect="non-scaling-stroke"
                      />
                      <text
                        x="80"
                        y={Math.max(4, pdcY - 1)}
                        fill="hsl(var(--muted-foreground))"
                        fontSize="2.6"
                        fontWeight="700"
                      >
                        PDC {pdcVal?.toFixed(1)}
                      </text>
                    </>
                  )}
                </svg>
              )}
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
                {upstoxNeedsSetup && (
                  <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm font-semibold text-warning">
                    Upstox OAuth is not connected. Open API Settings, tap Get Code, then Connect before starting live
                    data or orders.
                  </div>
                )}
                <div className="flex items-center justify-between rounded-md border border-border bg-surface p-4">
                  <div>
                    <p className="font-semibold">Start AI Trading</p>
                    <p className="text-sm text-muted-foreground">Trades Remaining: {tradesRemaining}/4</p>
                  </div>
                  <Switch
                    disabled={!session || isBusy || tradingBlocked || !upstoxReady}
                    checked={aiEnabled}
                    onCheckedChange={toggleAiTrading}
                    aria-label="Start AI Trading"
                  />
                </div>
                <div className="flex items-center justify-between rounded-md border border-warning/40 bg-warning/10 p-4">
                  <div>
                    <p className="font-semibold text-warning">AUTO-TRADE MODE</p>
                    <p className="text-xs text-muted-foreground">
                      Auto-fires order on every High-Probability signal — no manual click required.
                    </p>
                  </div>
                  <Switch
                    checked={autoTradeMode}
                    onCheckedChange={(v) => {
                      setAutoTradeMode(v);
                      localStorage.setItem(AUTO_TRADE_STORAGE_KEY, String(v));
                      toast({
                        title: v ? "AUTO-TRADE ENABLED" : "AUTO-TRADE DISABLED",
                        description: v
                          ? "High-probability signals will be executed instantly."
                          : "Manual confirmation required for execution.",
                      });
                    }}
                    aria-label="Auto Trade Mode"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="trading-lot-size" className="text-sm font-medium text-muted-foreground">
                    Trading Lot Size
                  </Label>
                  <Input
                    id="trading-lot-size"
                    type="number"
                    min="1"
                    step="1"
                    inputMode="numeric"
                    value={tradingLotSize}
                    onChange={(event) => setTradingLotSize(event.target.value)}
                    className="border-border bg-surface"
                  />
                  <p className="text-xs text-muted-foreground">Total quantity sent to Upstox: {totalTradingQuantity}</p>
                </div>
                {latestSignal?.riskSizeDown && (
                  <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm font-semibold text-warning">
                    Risk size-down active for this trade: quantity reduced to {suggestedQuantity}.
                  </div>
                )}
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="user-target-points" className="text-sm font-medium text-muted-foreground">
                      Premium Target Price
                    </Label>
                    <Input
                      id="user-target-points"
                      type="number"
                      min="0"
                      step="0.05"
                      inputMode="decimal"
                      value={userTargetPoints}
                      onChange={(event) => handleTargetPointsChange(event.target.value)}
                      className="border-border bg-surface"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="user-sl-points" className="text-sm font-medium text-muted-foreground">
                      Premium SL / TSL Price
                    </Label>
                    <Input
                      id="user-sl-points"
                      type="number"
                      min="0"
                      step="0.05"
                      inputMode="decimal"
                      value={userSlPoints}
                      onChange={(event) => handleSlPointsChange(event.target.value)}
                      className="border-border bg-surface"
                    />
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="daily-profit-target" className="text-sm font-medium text-muted-foreground">
                      Daily Profit Target
                    </Label>
                    <Input
                      id="daily-profit-target"
                      type="number"
                      min="0"
                      step="500"
                      inputMode="numeric"
                      value={dailyProfitTarget}
                      onChange={(event) => setDailyProfitTarget(event.target.value)}
                      className="border-border bg-surface"
                    />
                  </div>
                  <div className="rounded-md border border-loss/30 bg-loss/10 p-3">
                    <p className="text-xs text-muted-foreground">Daily Max Loss</p>
                    <p className="text-lg font-bold text-loss">₹{DAILY_STOP_LOSS.toLocaleString("en-IN")}</p>
                  </div>
                </div>
                {(targetAchieved || hardKillActive || cooldownActive) && (
                  <div
                    className={`rounded-md border p-3 text-sm font-semibold ${targetAchieved || cooldownActive ? "border-profit/30 bg-profit/10 text-profit" : "border-loss/30 bg-loss/10 text-loss"}`}
                  >
                    {cooldownActive
                      ? `Cooldown Active — next entry in ${cooldownRemainingMinutes} min.`
                      : targetAchieved
                        ? "Target Achieved — AI trading stopped for the day."
                        : "Hard Kill-Switch Active — max daily loss hit."}
                  </div>
                )}
                <div className="space-y-2">
                  <label className="text-sm font-medium text-muted-foreground">Trading Mode</label>
                  <Select
                    value={tradingMode}
                    onValueChange={(v) => {
                      setTradingMode(v as "scalping" | "sniper");
                      localStorage.setItem("zt_trading_mode", v);
                      setLatestSignal(null);
                      signalLockRef.current = null;
                      toast({
                        title: `Switched to ${v === "scalping" ? "Scalping" : "Sniper"} Mode`,
                        description: "Resetting AI reasoning and forcing a fresh analysis with the new logic.",
                      });
                      if (aiEnabled && !tradingBlocked) {
                        runTradingCycle().catch(() => {});
                      }
                    }}
                  >
                    <SelectTrigger className="border-border bg-surface text-foreground">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="scalping">Scalping (4–5 trades/day)</SelectItem>
                      <SelectItem value="sniper">Sniper (high-conviction only)</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Active: <span className="font-semibold text-foreground">{modeLabel}</span>
                  </p>
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
                <Button
                  disabled={!session || isBusy || tradingBlocked || !upstoxReady}
                  variant={aiEnabled ? "terminal" : "trading"}
                  className="w-full"
                  onClick={() => toggleAiTrading(!aiEnabled)}
                >
                  {aiEnabled ? "Armed" : "Arm AI Trading"}
                </Button>
                <Button
                  disabled={!session || isBusy || ((tradingBlocked || !upstoxReady) && !activeTrade)}
                  variant={activeTrade ? "destructive" : "terminal"}
                  className={`w-full ${activeTrade ? "min-h-20 animate-pulse text-2xl font-black" : ""}`}
                  onClick={() => (activeTrade ? emergencyExit(false) : executeTradingSignal())}
                >
                  {activeTrade ? "BIG RED EXIT ALL" : "Execute Live Order"}
                </Button>
                <Button
                  disabled={!session || isBusy || !upstoxReady || activeTrade}
                  variant="destructive"
                  className="w-full font-bold"
                  onClick={async () => {
                    setIsBusy(true);
                    try {
                      const live = await fetchLiveNifty(true, true);
                      const spot = Number(live?.ltp);
                      if (!Number.isFinite(spot)) throw new Error("Spot price unavailable");
                      const forced = await invokeFunction<LiveOrderResult>("place-live-order", {
                        action: "BUY",
                        spotPrice: spot,
                        tradingLotSize: normalizedTradingLotSize,
                        targetPremiumPoints: DEFAULT_PREMIUM_TARGET_POINTS,
                        stopLossPremiumPoints: DEFAULT_PREMIUM_SL_POINTS,
                        maxSlippagePct: execSettings.slippagePct,
                        forceManual: true,
                      });
                      if (!forced.success) throw new Error(forced.error || "Force trade rejected");
                      toast({
                        title: "FORCE TRADE PLACED",
                        description: `${forced.instrument.tradingSymbol} · Entry ₹${forced.entryPremium?.toFixed(2)}`,
                      });
                      setActiveTrade(true);
                      setLastExecution(forced);
                    } catch (e) {
                      toast({
                        title: "Force trade failed",
                        description: e instanceof Error ? e.message : String(e),
                        variant: "destructive",
                      });
                    } finally {
                      setIsBusy(false);
                    }
                  }}
                >
                  ⚡ MANUAL FORCE TRADE (Bypass AI)
                </Button>
                {activeTradePlan && (
                  <div
                    className={`rounded-md border p-3 ${exitAlertActive ? "border-loss bg-loss text-foreground" : "border-profit/30 bg-profit/10 text-profit"}`}
                  >
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <span className="text-sm font-semibold">
                        {exitAlertActive
                          ? activeTradePlan.exitAlertReason === "FINAL_TARGET"
                            ? "FINAL TARGET HIT — EXIT NOW"
                            : "TRAILING SL HIT — EXIT NOW"
                          : `Live: ${activeTradePlan.strike} · ${activeTradePlan.quantity} qty`}
                      </span>
                      <div className="text-left sm:text-right">
                        <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Current Profit/Loss</p>
                        <span
                          className={`text-3xl font-black ${currentTradePnlMoney >= 0 ? "text-profit" : "text-loss"}`}
                        >
                          {formatMoney(currentTradePnlMoney)}
                        </span>
                      </div>
                    </div>
                    <p className="mt-2 text-xs font-semibold text-muted-foreground">
                      Premium ₹
                      {activeTradePlan.currentPremium?.toFixed(2) ?? activeTradePlan.entryPremium?.toFixed(2) ?? "—"} ·
                      Target ₹{(activeTradePlan.targetPremium ?? activeTradePlan.target).toFixed(2)} / Server TSL ₹
                      {(activeTradePlan.stopLossPremium ?? activeTradePlan.stopLoss).toFixed(2)} · P/L ₹
                      {currentTradePnlPoints.toFixed(2)}
                    </p>
                    <div
                      className={`mt-2 inline-flex items-center gap-2 rounded-sm border px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] ${tslStatusTone}`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${tslActivated ? "bg-profit" : "bg-warning"}`} />
                      {tslStatusLabel}
                    </div>
                  </div>
                )}
              </div>
            </section>

            <section className="rounded-lg border border-border bg-panel p-5 shadow-panel">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Execution Layer · v6</p>
                  <h2 className="text-lg font-semibold">Order Execution & Liquidity</h2>
                </div>
                <ShieldCheck className="h-5 w-5 text-primary" />
              </div>

              {/* Status Badges */}
              <div className="mb-4 flex flex-wrap gap-2">
                {(() => {
                  const ex = lastExecution?.execution ?? {};
                  const blocked = ex.blocked;
                  const slipExit = ex.slippageExit;
                  const badges: Array<{ label: string; tone: string; on: boolean }> = [
                    {
                      label: "Order Placed ✅",
                      tone: "border-profit/40 bg-profit/10 text-profit",
                      on: !!ex.orderPlaced,
                    },
                    {
                      label: "Order Filled ✅",
                      tone: "border-profit/40 bg-profit/10 text-profit",
                      on: !!ex.orderFilled,
                    },
                    { label: "SL Active 🛡️", tone: "border-primary/40 bg-primary/10 text-primary", on: !!ex.slActive },
                    {
                      label: "Trailing Active 🔄",
                      tone: "border-warning/40 bg-warning/10 text-warning",
                      on: !!(
                        activeTradePlan &&
                        (activeTradePlan.stopLossPremium ?? 0) >
                          (activeTradePlan.entryPremium ?? 0) - (activeTradePlan.initialSlPoints ?? 0)
                      ),
                    },
                  ];
                  return (
                    <>
                      {badges.map((b) => (
                        <span
                          key={b.label}
                          className={`rounded-sm border px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] ${b.on ? b.tone : "border-border bg-surface text-muted-foreground opacity-60"}`}
                        >
                          {b.label}
                        </span>
                      ))}
                      {blocked && (
                        <span className="rounded-sm border border-loss/40 bg-loss/10 px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-loss">
                          Blocked: {blocked} ⚠️
                        </span>
                      )}
                      {slipExit && (
                        <span className="rounded-sm border border-loss/40 bg-loss/10 px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-loss">
                          Slippage Exit ⚠️
                        </span>
                      )}
                    </>
                  );
                })()}
              </div>

              {/* Slippage / Liquidity grid */}
              {lastExecution && (
                <div className="mb-4 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-md border border-border bg-surface p-3">
                    <p className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground">Slippage</p>
                    <p className="text-sm">
                      Quoted{" "}
                      <span className="font-semibold text-foreground">
                        ₹{lastExecution.slippage?.quotedLtp?.toFixed(2) ?? "—"}
                      </span>
                      {" → Fill "}
                      <span className="font-semibold text-foreground">
                        ₹{lastExecution.slippage?.fillPrice?.toFixed(2) ?? "—"}
                      </span>
                    </p>
                    <p
                      className={`mt-1 text-sm font-bold ${(lastExecution.slippage?.slippagePct ?? 0) > execSettings.slippagePct ? "text-loss" : "text-profit"}`}
                    >
                      {lastExecution.slippage?.slippagePct?.toFixed(2) ?? "—"}% (max {execSettings.slippagePct}%)
                    </p>
                  </div>
                  <div className="rounded-md border border-border bg-surface p-3">
                    <p className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground">Liquidity</p>
                    <p className="text-sm">
                      Bid{" "}
                      <span className="font-semibold text-foreground">
                        ₹{lastExecution.liquidity?.bid?.toFixed(2) ?? "—"}
                      </span>{" "}
                      · Ask{" "}
                      <span className="font-semibold text-foreground">
                        ₹{lastExecution.liquidity?.ask?.toFixed(2) ?? "—"}
                      </span>
                    </p>
                    <p className="mt-1 text-sm">
                      Spread{" "}
                      <span
                        className={`font-bold ${(lastExecution.liquidity?.spreadPct ?? 0) > execSettings.maxSpreadPct ? "text-loss" : "text-profit"}`}
                      >
                        {lastExecution.liquidity?.spreadPct?.toFixed(2) ?? "—"}%
                      </span>
                      {" · Vol "}
                      <span
                        className={`font-bold ${(lastExecution.liquidity?.volume ?? 0) < (lastExecution.liquidity?.minVolume ?? 5000) ? "text-loss" : "text-profit"}`}
                      >
                        {lastExecution.liquidity?.volume?.toLocaleString("en-IN") ?? "—"}
                      </span>
                      {" · "}
                      <span
                        className={`font-semibold ${(lastExecution.liquidity?.spreadPct ?? 0) <= execSettings.maxSpreadPct && (lastExecution.liquidity?.volume ?? 0) >= (lastExecution.liquidity?.minVolume ?? 5000) ? "text-profit" : "text-loss"}`}
                      >
                        {(lastExecution.liquidity?.spreadPct ?? 0) <= execSettings.maxSpreadPct &&
                        (lastExecution.liquidity?.volume ?? 0) >= (lastExecution.liquidity?.minVolume ?? 5000)
                          ? "GOOD"
                          : "LOW"}
                      </span>
                    </p>
                  </div>
                </div>
              )}

              {/* Active Trade execution details */}
              {activeTradePlan && lastExecution?.success && (
                <div className="mb-4 rounded-md border border-border bg-surface p-3 text-sm">
                  <p className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground">
                    Trade Execution Details
                  </p>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <div>
                      <p className="text-[11px] text-muted-foreground">Entry</p>
                      <p className="font-bold">₹{activeTradePlan.entryPremium?.toFixed(2) ?? "—"}</p>
                    </div>
                    <div>
                      <p className="text-[11px] text-muted-foreground">SL Trigger / Limit</p>
                      <p className="font-bold text-loss">
                        ₹
                        {lastExecution.slTriggerPrice?.toFixed(2) ?? activeTradePlan.stopLossPremium?.toFixed(2) ?? "—"}{" "}
                        / ₹{lastExecution.slLimitPrice?.toFixed(2) ?? "—"}
                      </p>
                    </div>
                    <div>
                      <p className="text-[11px] text-muted-foreground">Target</p>
                      <p className="font-bold text-profit">₹{activeTradePlan.targetPremium?.toFixed(2) ?? "—"}</p>
                    </div>
                    <div>
                      <p className="text-[11px] text-muted-foreground">Live P&L</p>
                      <p className={`font-bold ${currentTradePnlMoney >= 0 ? "text-profit" : "text-loss"}`}>
                        {formatMoney(currentTradePnlMoney)}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Block / error reason */}
              {lastExecution && !lastExecution.success && (
                <div className="mb-4 rounded-md border border-loss/40 bg-loss/10 p-3 text-sm">
                  <p className="font-semibold text-loss">Trade Blocked: {lastExecution.error ?? "Unknown"}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {lastExecution.details ?? "No details provided."}
                  </p>
                </div>
              )}

              {/* Settings sub-panel */}
              <div className="rounded-md border border-border bg-surface p-3">
                <p className="mb-3 text-[11px] uppercase tracking-wider text-muted-foreground">Execution Settings</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="exec-slippage" className="text-xs text-muted-foreground">
                      Slippage Tolerance (%)
                    </Label>
                    <Input
                      id="exec-slippage"
                      type="number"
                      step="0.1"
                      min="0.1"
                      max="10"
                      value={execSettings.slippagePct}
                      onChange={(e) =>
                        updateExecSettings({ slippagePct: Number(e.target.value) || DEFAULT_EXEC_SETTINGS.slippagePct })
                      }
                      className="h-8 border-border bg-panel"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="exec-spread" className="text-xs text-muted-foreground">
                      Max Spread (%)
                    </Label>
                    <Input
                      id="exec-spread"
                      type="number"
                      step="0.1"
                      min="0.1"
                      max="10"
                      value={execSettings.maxSpreadPct}
                      onChange={(e) =>
                        updateExecSettings({
                          maxSpreadPct: Number(e.target.value) || DEFAULT_EXEC_SETTINGS.maxSpreadPct,
                        })
                      }
                      className="h-8 border-border bg-panel"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="exec-retries" className="text-xs text-muted-foreground">
                      Retry Attempts
                    </Label>
                    <Input
                      id="exec-retries"
                      type="number"
                      step="1"
                      min="0"
                      max="5"
                      value={execSettings.retries}
                      onChange={(e) => updateExecSettings({ retries: Number(e.target.value) || 0 })}
                      className="h-8 border-border bg-panel"
                    />
                  </div>
                  <div className="flex items-center justify-between rounded-md border border-border bg-panel p-2">
                    <div>
                      <p className="text-xs font-semibold">Liquidity Filter</p>
                      <p className="text-[10px] text-muted-foreground">Skip low-volume / wide-spread strikes</p>
                    </div>
                    <Switch
                      checked={execSettings.liquidityFilter}
                      onCheckedChange={(v) => updateExecSettings({ liquidityFilter: v })}
                      aria-label="Liquidity filter"
                    />
                  </div>
                </div>
                <p className="mt-2 text-[10px] text-muted-foreground">
                  Slippage tolerance is sent to the order engine on every trade. Spread / retries / liquidity filter are
                  enforced server-side; UI values reflect your preferences.
                </p>
              </div>
            </section>

            {/* ===== Execution Debug Panel ===== */}
            <section className="rounded-lg border border-border bg-panel p-5 shadow-panel">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Debug · Trace</p>
                  <h2 className="text-lg font-semibold">Signal → Order → SL → Trailing</h2>
                </div>
                {debugEvents.length > 0 && (
                  <button
                    onClick={() => setDebugEvents([])}
                    className="rounded-sm border border-border bg-surface px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
                  >
                    Clear
                  </button>
                )}
              </div>

              {/* Status summary cards */}
              <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {(() => {
                  const ex = lastExecution?.execution ?? {};
                  const lastSig = debugEvents.find((e) => e.stage === "SIGNAL");
                  const lastOrder = debugEvents.find((e) => e.stage === "ORDER" && e.level === "success");
                  const lastSl = debugEvents.find((e) => e.stage === "SL");
                  const lastTrail = debugEvents.find((e) => e.stage === "TRAILING");
                  const cells = [
                    {
                      k: "Signal",
                      v: lastSig?.title ?? (latestSignal?.action ? `WAITING (${latestSignal.action})` : "Idle"),
                      tone: lastSig ? "border-profit/40 text-profit" : "border-border text-muted-foreground",
                    },
                    {
                      k: "Order",
                      v: lastOrder?.title ?? (ex.orderPlaced ? "ORDER PLACED" : "Idle"),
                      tone: lastOrder ? "border-profit/40 text-profit" : "border-border text-muted-foreground",
                    },
                    {
                      k: "SL",
                      v: ex.slActive ? "SL ACTIVE" : (lastSl?.title ?? "Idle"),
                      tone: ex.slActive ? "border-primary/40 text-primary" : "border-border text-muted-foreground",
                    },
                    {
                      k: "Trailing",
                      v: lastTrail?.title ?? "Idle",
                      tone: lastTrail ? "border-warning/40 text-warning" : "border-border text-muted-foreground",
                    },
                  ];
                  return cells.map((c) => (
                    <div key={c.k} className={`rounded-md border bg-surface p-2 ${c.tone}`}>
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{c.k}</p>
                      <p className="text-[11px] font-bold leading-tight">{c.v}</p>
                    </div>
                  ));
                })()}
              </div>

              {/* Event log */}
              <div className="max-h-64 overflow-y-auto rounded-md border border-border bg-surface">
                {debugEvents.length === 0 ? (
                  <p className="p-3 text-xs text-muted-foreground">
                    No execution events yet. Events appear here in real-time as signals fire and orders are placed.
                  </p>
                ) : (
                  <ul className="divide-y divide-border">
                    {debugEvents.map((e) => {
                      const tone =
                        e.level === "error"
                          ? "text-loss"
                          : e.level === "warn"
                            ? "text-warning"
                            : e.level === "success"
                              ? "text-profit"
                              : "text-foreground";
                      const stageTone =
                        e.stage === "ERROR"
                          ? "border-loss/40 bg-loss/10 text-loss"
                          : e.stage === "TRAILING"
                            ? "border-warning/40 bg-warning/10 text-warning"
                            : e.stage === "SL"
                              ? "border-primary/40 bg-primary/10 text-primary"
                              : e.stage === "FILL" || e.stage === "ORDER"
                                ? "border-profit/40 bg-profit/10 text-profit"
                                : "border-border bg-panel text-muted-foreground";
                      return (
                        <li key={e.id} className="flex items-start gap-2 p-2 text-xs">
                          <span
                            className={`shrink-0 rounded-sm border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${stageTone}`}
                          >
                            {e.stage}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className={`font-semibold ${tone}`}>{e.title}</p>
                            {e.detail && <p className="truncate text-[11px] text-muted-foreground">{e.detail}</p>}
                          </div>
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            {new Date(e.ts).toLocaleTimeString("en-IN", { hour12: false })}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
              <p className="mt-2 text-[10px] text-muted-foreground">
                Full payloads also logged to browser console (F12) with [SIGNAL], [ORDER], [FILL], [SL], [TRAILING],
                [ERROR] tags.
              </p>
            </section>

            <section className={`rounded-lg border bg-panel p-5 shadow-market ${aiPanelTone}`}>
              <div className="mb-3 flex items-center gap-2 text-primary">
                <Activity className="h-5 w-5" />
                <h2 className="text-lg font-semibold text-foreground">Live AI Reasoning</h2>
              </div>
              <p className={`min-h-20 rounded-md border bg-surface p-4 text-sm leading-6 ${aiTextTone}`}>{reasoning}</p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-md border border-border bg-surface p-3">
                  <div className="mb-2 flex items-center justify-between text-sm">
                    <span className="font-semibold text-muted-foreground">PCR</span>
                    <span className="font-bold text-foreground">{pcrValue === null ? "—" : pcrValue.toFixed(3)}</span>
                  </div>
                  <Progress value={clampMeter(pcrValue, 2)} className="h-2" />
                  <p className="mt-2 text-xs text-muted-foreground">
                    {latestSignal?.ruleContext?.rules?.pcrState ?? "Pending"}
                  </p>
                </div>
                <div className="rounded-md border border-border bg-surface p-3">
                  <div className="mb-2 flex items-center justify-between text-sm">
                    <span className="font-semibold text-muted-foreground">India VIX</span>
                    <span className="font-bold text-foreground">{vixValue === null ? "—" : vixValue.toFixed(2)}</span>
                  </div>
                  <Progress value={clampMeter(vixValue, 30)} className="h-2" />
                  <p className="mt-2 text-xs text-muted-foreground">
                    {latestSignal?.ruleContext?.rules?.vixSizeCut
                      ? "Size -50%"
                      : latestSignal?.ruleContext?.rules?.vixRising
                        ? "Rising"
                        : "Normal"}
                  </p>
                </div>
              </div>
            </section>
          </aside>
        </div>

        <section className="rounded-lg border border-border bg-panel p-5 shadow-panel">
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Ghanshyam Sir Foundation</p>
              <h2 className="text-xl font-semibold">Current Levels</h2>
            </div>
            <span className="text-xs text-muted-foreground">
              Auto-refresh every 1m · forced re-analysis on &gt;15pt move
              {yesterdayLevels?.date ? ` · Yesterday ${yesterdayLevels.date}` : ""}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <div className="rounded-md border border-warning/30 bg-warning/5 p-3">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">PDH</p>
              <p className="mt-1 text-lg font-bold text-warning">{pdhVal === null ? "—" : pdhVal.toFixed(2)}</p>
            </div>
            <div className="rounded-md border border-warning/30 bg-warning/5 p-3">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">PDL</p>
              <p className="mt-1 text-lg font-bold text-warning">{pdlVal === null ? "—" : pdlVal.toFixed(2)}</p>
            </div>
            <div className="rounded-md border border-border bg-surface p-3">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">PDC</p>
              <p className="mt-1 text-lg font-bold text-foreground">{pdcVal === null ? "—" : pdcVal.toFixed(2)}</p>
            </div>
            <div className="rounded-md border border-profit/30 bg-profit/5 p-3">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Immediate Resistance</p>
              <p className="mt-1 text-lg font-bold text-profit">
                {immediateResistance === null ? "—" : immediateResistance.toFixed(2)}
              </p>
            </div>
            <div className="rounded-md border border-loss/30 bg-loss/5 p-3">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Immediate Support</p>
              <p className="mt-1 text-lg font-bold text-loss">
                {immediateSupport === null ? "—" : immediateSupport.toFixed(2)}
              </p>
            </div>
          </div>
          {hasLivePrice && (pdhVal !== null || pdlVal !== null) && (
            <p className="mt-3 text-xs text-muted-foreground">
              Spot {latestLtp.toLocaleString("en-IN")} ·{" "}
              {pdhVal !== null && latestLtp > pdhVal ? (
                <span className="font-semibold text-profit">Above PDH (Bullish bias)</span>
              ) : pdlVal !== null && latestLtp < pdlVal ? (
                <span className="font-semibold text-loss">Below PDL (Bearish bias)</span>
              ) : pdcVal !== null && latestLtp > pdcVal ? (
                <span className="font-semibold text-profit">Above PDC</span>
              ) : pdcVal !== null && latestLtp < pdcVal ? (
                <span className="font-semibold text-loss">Below PDC</span>
              ) : (
                <span>Inside yesterday's range</span>
              )}
            </p>
          )}
        </section>

        <div className="grid gap-5 md:grid-cols-2">
          {[
            { symbol: ceSymbol, ltp: ceLtpLive, mini: ceMini, series: ceSeries, tone: "profit" as const },
            { symbol: peSymbol, ltp: peLtpLive, mini: peMini, series: peSeries, tone: "loss" as const },
          ].map((opt) => (
            <section key={opt.symbol} className="rounded-lg border border-border bg-panel p-4 shadow-panel">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
                    ATM {opt.tone === "profit" ? "Call" : "Put"} · {atmExpiry ?? "—"}
                  </p>
                  <h3 className="text-base font-semibold text-foreground">{opt.symbol}</h3>
                </div>
                <span className={`text-xl font-bold ${opt.tone === "profit" ? "text-profit" : "text-loss"}`}>
                  {opt.ltp === null ? "—" : `₹${opt.ltp.toFixed(2)}`}
                </span>
              </div>
              <div className="relative h-32 rounded-md border border-border bg-surface">
                {opt.mini.points ? (
                  <svg
                    className="absolute inset-0 h-full w-full"
                    preserveAspectRatio="none"
                    viewBox="0 0 100 100"
                    aria-hidden="true"
                  >
                    <polyline
                      points={opt.mini.points}
                      fill="none"
                      stroke={opt.tone === "profit" ? "hsl(var(--profit))" : "hsl(var(--loss))"}
                      strokeWidth="1.5"
                      vectorEffect="non-scaling-stroke"
                    />
                  </svg>
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                    {opt.series.length === 1 ? "Collecting first ticks…" : "Waiting for live ATM premium…"}
                  </div>
                )}
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Range: {opt.mini.points ? `₹${opt.mini.min.toFixed(2)} – ₹${opt.mini.max.toFixed(2)}` : "—"} ·
                Auto-switches when ATM strike changes
              </p>
            </section>
          ))}
        </div>

        <div className="grid gap-5 lg:grid-cols-[1.35fr_0.65fr]">
          <section className="overflow-hidden rounded-lg border border-border bg-panel shadow-panel">
            <div className="flex items-center gap-2 border-b border-border p-4">
              <SlidersHorizontal className="h-5 w-5 text-accent" />
              <h2 className="text-xl font-semibold">Trade History</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] text-left text-sm">
                <thead className="bg-surface text-xs uppercase text-muted-foreground">
                  <tr>
                    {["Time", "Instrument", "Entry Price", "Exit Price", "P&L"].map((head) => (
                      <th key={head} className="px-4 py-3 font-semibold">
                        {head}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {history.map((trade) => (
                    <tr
                      key={`${trade.time}-${trade.instrument}`}
                      className="border-t border-border transition-colors hover:bg-surface/70"
                    >
                      <td className="px-4 py-4 text-muted-foreground">{trade.time}</td>
                      <td className="px-4 py-4 font-semibold">{trade.instrument}</td>
                      <td className="px-4 py-4">{trade.entry}</td>
                      <td className="px-4 py-4">{trade.exit}</td>
                      <td className={`px-4 py-4 font-bold ${trade.result === "profit" ? "text-profit" : "text-loss"}`}>
                        {trade.pnl}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-lg border border-border bg-panel p-5 shadow-panel">
            <div className="mb-5 flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Daily Limit</p>
                <h2 className="text-xl font-semibold">Risk Guardrails</h2>
              </div>
              <ShieldCheck className="h-6 w-6 text-primary" />
            </div>
            <div className="space-y-5">
              <div className="rounded-md border border-border bg-surface p-3">
                <p className="text-xs text-muted-foreground">Max Trades</p>
                <p className="mt-1 text-sm font-semibold text-foreground">Trades Remaining: {tradesRemaining}/4</p>
              </div>
              <div className="rounded-md border border-loss/30 bg-loss/10 p-3">
                <p className="text-xs text-muted-foreground">Daily Max Loss</p>
                <p className="mt-1 text-sm font-semibold text-loss">
                  Hard lock at -₹{DAILY_STOP_LOSS.toLocaleString("en-IN")}
                </p>
              </div>
              <div className="rounded-md border border-border bg-surface p-3">
                <p className="text-xs text-muted-foreground">Premium Server TSL</p>
                <p className="mt-1 text-sm font-semibold text-foreground">
                  Server SL-M is placed immediately and modified every ₹5 favorable premium move.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-md border border-border bg-surface p-3">
                  <Gauge className="mb-2 h-5 w-5 text-warning" />
                  <p className="text-xs text-muted-foreground">Used Today</p>
                  <p className="font-bold">
                    {executedTrades} / {MAX_TRADES_PER_DAY}
                  </p>
                </div>
                <div
                  className={`rounded-md border bg-surface p-3 ${tradingBlocked ? "border-loss/40" : "border-border"}`}
                >
                  <IndianRupee className="mb-2 h-5 w-5 text-loss" />
                  <p className="text-xs text-muted-foreground">Today's P&L</p>
                  <p className={`font-bold ${dailyPnl >= 0 ? "text-profit" : "text-loss"}`}>
                    ₹{dailyPnl.toLocaleString("en-IN")}
                  </p>
                </div>
              </div>
            </div>
          </section>
        </div>
        <section className="mx-auto mt-4 w-full max-w-6xl px-3 pb-6">
          <div className="rounded-lg border border-border bg-surface p-3 text-xs">
            <div className="mb-1 flex items-center justify-between">
              <span className="font-semibold uppercase tracking-wide text-muted-foreground">VPS Console · Last Error</span>
              {lastVpsError && (
                <button
                  type="button"
                  className="text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => setLastVpsError(null)}
                >
                  clear
                </button>
              )}
            </div>
            {lastVpsError ? (
              <div>
                <div className="text-[11px] text-muted-foreground">
                  {new Date(lastVpsError.at).toLocaleTimeString()} · {lastVpsError.where}
                </div>
                <pre className="mt-1 whitespace-pre-wrap break-all text-destructive">{lastVpsError.message}</pre>
              </div>
            ) : (
              <div className="text-muted-foreground">No errors recorded from VPS.</div>
            )}
          </div>
        </section>
      </section>
    </main>
  );
};

export default Index;
