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
import { Badge } from "@/components/ui/badge";
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
import { ProEngineStatus, usePersistedEngineState } from "@/components/ProEngineStatus";
import { EngineDebugPanel } from "@/components/EngineDebugPanel";

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
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Backend ${res.status}`);
  const statusRes = await fetch(`${apiBase}/status`, {
    method: "GET",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    cache: "no-store",
  });
  if (!statusRes.ok) throw new Error(`Backend status ${statusRes.status}`);
  const data = await statusRes.json().catch(() => ({}));
  const fallbackMode = target.toUpperCase();
  const parsedMode = String(data?.mode ?? data?.current_mode ?? data?.trading_mode ?? data?.auto_mode ?? fallbackMode).toUpperCase();
  return { status: String(data?.status ?? "ONLINE"), mode: parsedMode === "AUTO" || parsedMode === "MANUAL" ? parsedMode : fallbackMode };
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
const AI_REASONING_INTERVAL_MS = 5_000;
const AI_RUNTIME_CACHE_VERSION = "ai-reasoning-live-v3";
const AI_RUNTIME_CACHE_VERSION_KEY = "zenith-ai-runtime-cache-version";
// PRO+++ stability patch: relaxed drift triggers so scalping context stays stable.
// Only force fresh AI analysis on large spot drifts; small ticks must NOT wipe state.
const AI_SPOT_DRIFT_TRIGGER_PTS = 120;
// Cached S/R is only considered "stale" when extremely far from current spot.
// Frontend NEVER hides S/R based on this — backend is the only sanitizer.
const SR_STALE_DISTANCE_PTS = 500;
const NIFTY_LOT_SIZE = 65;
const MAX_TRADES_PER_DAY = 4;
const DAILY_STOP_LOSS = 2000;
const DEFAULT_PREMIUM_TARGET_POINTS = 25;
const DEFAULT_PREMIUM_SL_POINTS = 15;
const PREMIUM_TSL_STEP = 3; // v7-aggressive: trail every +3pts (was 5)
const COOLDOWN_MS = 5 * 60 * 1000; // v7-aggressive: 5min cooldown (was 15)
const SIGNAL_LOCK_MS = 30_000;
const SIGNAL_STALE_MS = 15_000;
// Execution retry config — keep locked signal alive across transient VPS hiccups.
const EXEC_MAX_ATTEMPTS = 3;
const EXEC_BACKOFF_MS = [1_000, 2_000, 4_000];
const VPS_OFFLINE_AUTODISABLE_MS = 60_000;
type ExecutionState =
  | "IDLE"
  | "PENDING"
  | "SENDING"
  | "VPS_CONNECTED"
  | "EXECUTING"
  | "ORDER_SENT"
  | "ORDER_ACCEPTED"
  | "WAITING_FOR_FILL"
  | "FILLED"
  | "REJECTED"
  | "CANCELLED"
  | "FAILED";
// Fill-confirmation polling tuning
const FILL_POLL_INTERVAL_MS = 2_000;
const FILL_POLL_MAX_ATTEMPTS = 30; // ~60s total before [FILL_TIMEOUT]

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
    if (date !== todayKey() || !payload) return null;
    const parsed = JSON.parse(payload);
    const legacyTokenKey = "instrument" + "Token";
    if (parsed?.[legacyTokenKey] && !parsed.instrument_token) {
      parsed.instrument_token = parsed[legacyTokenKey];
      delete parsed[legacyTokenKey];
    }
    return parsed;
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
    ltp?: number | null;
    support15?: number | null;
    resistance15?: number | null;
    immediateSupport?: number | null;
    immediateResistance?: number | null;
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
  analysisTimestamp?: string;
  payloadTimestamp?: string;
  liveSpot?: number | null;
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
        ce?: { instrument_token?: string; tradingSymbol?: string; strike?: number; ltp?: number | null } | null;
        pe?: { instrument_token?: string; tradingSymbol?: string; strike?: number; ltp?: number | null } | null;
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
  instrument_token?: string;
  slOrderId?: string;
  entryPremium?: number;
  currentPremium?: number;
  targetPremium?: number;
  stopLossPremium?: number;
  lastSyncedStopLossPremium?: number;
  exitAlertReason?: "TRAILING_SL" | "FINAL_TARGET";
  // Locked-contract immutables (set at fill, never mutated)
  tradingSymbol?: string;
  optionSide?: "CE" | "PE";
  signalStrike?: number;
  executedStrike?: number;
  entryPremiumSnapshot?: number;
  spotPriceAtSignal?: number;
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
  instrument_token?: string;
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
  // v8 additive: explicit fallback fields + Upstox rejection trace
  fillPrice?: number;
  optionLtp?: number;
  productUsed?: "I" | "D";
  orderTypeUsed?: "MARKET" | "LIMIT";
  sentPayload?: Record<string, unknown>;
  upstox_response?: unknown;
  upstox_status?: number | null;
  httpStatusChain?: Record<string, unknown>;
  stage?: string;
  trace?: string[];
  entryAttempts?: Array<{ product: string; order_type: string; ok: boolean; error?: string; payload?: Record<string, unknown> }>;
  errorDetails?: {
    reason?: string;
    attempts?: Array<{ product: string; order_type: string; ok: boolean; error?: string; payload?: Record<string, unknown> }>;
    failedField?: string | null;
    rejectedPayload?: Record<string, unknown> | null;
  };
};
type VpsForensics = {
  endpoint: string;
  method: string;
  frontendToVpsStatus: number | null;
  vpsToUpstoxStatus: number | null;
  stage: string | null;
  trace: string[];
  missingField: string | null;
  rejectedField: string | null;
  requestPayload: Record<string, unknown> | null;
  rawResponseBody: unknown;
  rawResponseText: string;
  at: number;
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
  const aiAnalysisInFlightRef = useRef(false);
  // Race-safe sync mirror of `activeTrade` state so async loops never see stale closures.
  const activeTradeRef = useRef(false);
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
  // Frozen option contract resolved at signal generation. Never recomputed during execution.
  const signalContractRef = useRef<{
    signalKey: string;
    strike: number;
    optionSide: "CE" | "PE";
    action: "BUY" | "SELL";
    instrument_token: string;
    tradingSymbol: string;
    expiry?: string;
    premiumAtSignal: number;
    spotPriceAtSignal: number | null;
    lockedAt: number;
  } | null>(null);
  // Execution lifecycle: keep locked signal stable while order attempts are in-flight,
  // even across temporary VPS unreachable errors.
  const executionStateRef = useRef<ExecutionState>("IDLE");
  // IMMUTABLE locked trade snapshot — captured at ORDER_ACCEPTED, cleared only on exit.
  // While set, the UI must FREEZE signal/confidence/reasoning panels and the AI loop
  // must NOT generate or apply new signals (TRADE MANAGEMENT MODE).
  type LockedTradeContext = {
    action: "BUY" | "SELL";
    strike: number;
    optionSide: "CE" | "PE";
    tradingSymbol: string;
    instrument_token: string;
    confidenceSnapshot: number;
    reasoningSnapshot: string;
    supportSnapshot: number | null;
    resistanceSnapshot: number | null;
    stopLossPremium: number;
    targetPremium: number;
    entryPremium: number;
    signalCreatedAt: string | null;
    lockedAt: number;
  };
  const lockedTradeContextRef = useRef<LockedTradeContext | null>(null);
  const [lockedTradeContext, setLockedTradeContext] = useState<LockedTradeContext | null>(null);
  const vpsOfflineSinceRef = useRef<number | null>(null);
  // Session-restore guards: prevent the "Saved Upstox access token found…" flow
  // from spamming /system-status calls and re-triggering the AI loop on every render.
  const sessionRestoreInFlightRef = useRef<Promise<UpstoxStatus | null> | null>(null);
  const sessionRestoreCacheRef = useRef<{ at: number; data: UpstoxStatus | null } | null>(null);
  const SESSION_RESTORE_TTL_MS = 60_000;
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
  // Keep the ref in lock-step with state so async closures see the latest value synchronously.
  useEffect(() => { activeTradeRef.current = activeTrade; }, [activeTrade]);
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
  const [backendMode, setBackendMode] = useState<"AUTO" | "MANUAL" | "WAIT" | "UNKNOWN">("UNKNOWN");
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
  const [lastAiUpdateAt, setLastAiUpdateAt] = useState<number | null>(null);
  const [aiHeartbeat, setAiHeartbeat] = useState<string>("Analyzing trend...");
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
  const [executionState, setExecutionState] = useState<ExecutionState>("IDLE");
  const [executionAttempt, setExecutionAttempt] = useState(0);
  const [executionError, setExecutionError] = useState<string | null>(null);
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
  type PayloadInspector = {
    signalTimestamp: string;
    signalAgeSec: number | null;
    liveSpotPrice: number | null;
    suggestedStrike: number | null;
    derivedOptionSide: "CE" | "PE" | null;
    action: string | null;
    transactionType: "BUY" | "SELL" | null;
    quantity: number | null;
    ce_instrument_token?: string | null;
    pe_instrument_token?: string | null;
    instrument_token?: string | null;
    vpsEndpointUrl: string;
    retryAttempt: number;
    orderPayload: Record<string, unknown> | null;
    missingFields: string[];
    // Strike-lock forensics
    signalStrike?: number | null;
    executedStrike?: number | null;
    strikeMatch?: boolean | null;
    premiumAtSignal?: number | null;
    premiumAtFill?: number | null;
    lockedTradingSymbol?: string | null;
    lockedInstrumentToken?: string | null;
  };
  const [debugEvents, setDebugEvents] = useState<DebugEvent[]>([]);
  const [payloadInspector, setPayloadInspector] = useState<PayloadInspector | null>(null);
  const [executionRootCause, setExecutionRootCause] = useState<string | null>(null);
  const [vpsForensics, setVpsForensics] = useState<VpsForensics | null>(null);
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
  const isPresent = (value: unknown) => value !== null && value !== undefined && value !== "";
  const isPositiveNumber = (value: unknown) => Number.isFinite(Number(value)) && Number(value) > 0;
  const classifyExecutionRootCause = (message: string) => {
    const lower = message.toLowerCase();
    if (lower.includes("product")) return lower.includes("invalid") ? "Rejected field: product" : "Missing field: product";
    if (lower.includes("order_type")) return lower.includes("invalid") ? "Rejected field: order_type" : "Missing field: order_type";
    if (lower.includes("validity")) return lower.includes("invalid") ? "Rejected field: validity" : "Missing field: validity";
    if (lower.includes("transaction_type") || lower.includes("transactiontype")) return "transaction_type missing";
    if (lower.includes("instrument_token")) return "instrument_token missing";
    if (lower.includes("token_mismatch")) return "option token / side mismatch";
    if (lower.includes("stale signal")) return "stale signal";
    if (lower.includes("livemarket") || lower.includes("live market") || lower.includes("spot price")) return "liveMarket unavailable";
    if (lower.includes("option side")) return "invalid option side";
    if (lower.includes("quantity")) return "quantity missing";
    if (lower.includes("timeout") || lower.includes("timed out")) return "VPS timeout";
    if (lower.includes("unreachable") || lower.includes("failed to fetch") || lower.includes("tunnel")) return "tunnel unreachable";
    if (lower.includes("upstox") || lower.includes("rejected") || lower.includes("udapi")) return "Upstox rejection";
    return message || "unknown";
  };
  const extractRejectedField = (payload: unknown) => {
    const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? "");
    return text.match(/(?:missing_field|missing field|rejected field|field)[:\s"']+([a-zA-Z0-9_.-]+)/i)?.[1] ?? null;
  };
  const vpsErrorMessage = (payload: Record<string, unknown>, status: number) => {
    const parts = [payload.error, payload.detail, payload.details, payload.missing_field && `missing_field: ${payload.missing_field}`]
      .filter(Boolean)
      .map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
    return parts.join(" — ") || `VPS ${status}`;
  };

  // PRO+++ stability: never blank the UI. Reset internal locks but keep the last
  // visible signal so support/resistance, reasoning, and confidence persist.
  // Active execution always wins — no reset is allowed while a trade is in-flight.
  const clearAiRuntimeState = (opts: { force?: boolean } = {}) => {
    if (!opts.force && isExecutionActive()) {
      console.log("[STATE GUARD] suppressed clearAiRuntimeState — execution active");
      return;
    }
    signalLockRef.current = null;
    levelsAnchorLtpRef.current = null;
    lastSignalAutofillRef.current = "";
    lastSignalAlertRef.current = "";
    lastDebugSignalKeyRef.current = "";
    lastAutoFiredSignalRef.current = "";
    // Intentionally do NOT call setLatestSignal(null) — keep last valid signal
    // visible so the dashboard never flickers or blanks. New signal will replace it.
  };

  const signalLiveSpot = (signal?: Signal | null) =>
    toNumber(signal?.liveSpot ?? signal?.ruleContext?.rules?.ltp ?? (signal as any)?.entry ?? (signal as any)?.entryPrice);
  const isSignalStaleVsSpot = (signal: Signal | null | undefined, spot: number | null = hasLivePrice ? latestLtp : null) => {
    const liveSpot = toNumber(spot);
    if (!signal || liveSpot === null) return false;
    const signalSpot = signalLiveSpot(signal);
    // Only flag stale on large spot drift. S/R distance handled server-side.
    return signalSpot !== null && Math.abs(liveSpot - signalSpot) > AI_SPOT_DRIFT_TRIGGER_PTS;
  };

  // True while an order is being attempted (incl. retry backoff window and waiting-for-fill).
  const isExecutionActive = () => {
    const s = executionStateRef.current;
    return (
      s === "PENDING" ||
      s === "SENDING" ||
      s === "VPS_CONNECTED" ||
      s === "EXECUTING" ||
      s === "ORDER_SENT" ||
      s === "ORDER_ACCEPTED" ||
      s === "WAITING_FOR_FILL"
    );
  };
  // Polling controller for broker fill confirmation. Single in-flight poll only.
  const fillPollRef = useRef<{ cancelled: boolean; orderId: string | null }>({ cancelled: false, orderId: null });

  const applyFreshSignal = (signal: Signal, liveSpot: number | null) => {
    // SINGLE-POSITION LOCK: ignore any signal while a trade is open (race-safe via ref).
    if (activeTradeRef.current || activeTrade || lockedTradeContextRef.current) {
      console.log("[SIGNAL LOCK] suppressed AI overwrite — position active (locked)");
      return false;
    }
    // Freeze signal panel while an execution is in-flight.
    if (isExecutionActive() && signalLockRef.current) {
      console.log("[SIGNAL LOCK] suppressed AI overwrite — execution active");
      return false;
    }
    // Stale signal: do NOT wipe UI. Keep last valid signal visible; just skip apply.
    if (isSignalStaleVsSpot(signal, liveSpot)) {
      console.log("[SIGNAL STALE] ignored fresh signal — spot drift too large, keeping last valid");
      return false;
    }
    levelsAnchorLtpRef.current = liveSpot ?? signalLiveSpot(signal);
    signalLockRef.current = signal.action !== "WAIT" ? { signal, lockedUntil: Date.now() + SIGNAL_LOCK_MS } : null;
    setLatestSignal(signal);
    setLastAiUpdateAt(Date.now());
    return true;
  };

  const applySniperSignal = (signal: Signal) => {
    if (activeTradeRef.current || activeTrade || lockedTradeContextRef.current) {
      console.log("[SIGNAL LOCK] suppressed sniper overwrite — position active (locked)");
      return;
    }
    if (isExecutionActive() && signalLockRef.current) {
      console.log("[SIGNAL LOCK] suppressed sniper overwrite — execution active");
      return;
    }
    if (isSignalStaleVsSpot(signal)) {
      console.log("[SIGNAL STALE] ignored sniper signal — spot drift too large");
      return;
    }
    let locked = signalLockRef.current;
    const now = Date.now();
    if (locked && isSignalStaleVsSpot(locked.signal)) {
      signalLockRef.current = null;
      locked = null;
    }
    if (locked && now < locked.lockedUntil) {
      const fullReversal = signal.action !== "WAIT" && signal.action !== locked.signal.action;
      const majorBreak =
        signal.ruleContext?.rules?.priceAboveEma21 !== locked.signal.ruleContext?.rules?.priceAboveEma21 ||
        signal.ruleContext?.rules?.priceBelowEma21 !== locked.signal.ruleContext?.rules?.priceBelowEma21;
      if (signal.action === "WAIT" && !majorBreak) {
        // WAIT must not overwrite an active directional signal's visuals.
        return;
      }
      if (!fullReversal && signal.action !== locked.signal.action) {
        return;
      }
    }
    if (signal.action !== "WAIT") signalLockRef.current = { signal, lockedUntil: now + SIGNAL_LOCK_MS };
    else if (!locked || now >= locked.lockedUntil) signalLockRef.current = null;
    setLatestSignal(signal);
    setLastAiUpdateAt(Date.now());
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
  // PRO+++ stability: backend is the only S/R sanitizer. Frontend MUST NOT hide
  // valid levels based on small spot movements — keep displayed data visible.
  const srStale = false;
  const immediateSupport = rawImmediateSupport;
  const immediateResistance = rawImmediateResistance;
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
      const cacheVersion = localStorage.getItem(AI_RUNTIME_CACHE_VERSION_KEY);
      if (cacheVersion !== AI_RUNTIME_CACHE_VERSION) {
        Object.keys(localStorage).forEach((key) => {
          const lower = key.toLowerCase();
          if (lower.includes("signal") || lower.includes("reason") || lower.includes("level") || lower.includes("current")) {
            localStorage.removeItem(key);
          }
        });
        Object.keys(sessionStorage).forEach((key) => {
          const lower = key.toLowerCase();
          if (lower.includes("signal") || lower.includes("reason") || lower.includes("level") || lower.includes("current")) {
            sessionStorage.removeItem(key);
          }
        });
        localStorage.setItem(AI_RUNTIME_CACHE_VERSION_KEY, AI_RUNTIME_CACHE_VERSION);
      }
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
    clearAiRuntimeState({ force: true });
    setLatestSignal(null);
  }, []);

  useEffect(() => {
    const clock = setInterval(() => setMarketClock(new Date()), 30_000);
    return () => clearInterval(clock);
  }, []);

  // Rotating AI heartbeat: independent of polling cycles so the reasoning panel
  // always shows visible "alive" feedback even when no fresh signal arrives.
  useEffect(() => {
    const messages = [
      "Analyzing trend...",
      "Checking momentum...",
      "Evaluating volatility...",
      "Scanning support/resistance...",
    ];
    let i = 0;
    setAiHeartbeat(messages[0]);
    const t = setInterval(() => {
      i = (i + 1) % messages.length;
      setAiHeartbeat(messages[i]);
    }, 30_000);
    return () => clearInterval(t);
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

  // VPS tunnel health ping — every 5s. Drives the green "VPS TUNNEL ACTIVE" badge
  // and keeps backendMode (AUTO/MANUAL) in sync via /status.
  useEffect(() => {
    const ping = async () => {
      let healthy = false;
      try {
        const method = getStatusEndpointMethod(vpsStatusEndpoint);
        const r = await fetch(`${normalizedVpsBaseUrl}${vpsStatusEndpoint}`, {
          method,
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: method === "POST" ? JSON.stringify({ target: "upstox" }) : undefined,
        });
        healthy = r.ok;
        setTunnelOnline(r.ok);
        if (!r.ok) {
          const txt = await r.text().catch(() => "");
          recordVpsError(`${method} ${vpsStatusEndpoint}`, `${r.status} ${txt || r.statusText}`);
        }
      } catch (err) {
        setTunnelOnline(false);
        recordVpsError(`${getStatusEndpointMethod(vpsStatusEndpoint)} ${vpsStatusEndpoint}`, err instanceof Error ? err.message : String(err));
      }
      // Track sustained offline duration → auto-disable AUTO trading after 60s.
      const now = Date.now();
      if (healthy) {
        if (vpsOfflineSinceRef.current !== null) {
          console.log("[TUNNEL STATUS] reconnected after", now - vpsOfflineSinceRef.current, "ms");
        }
        vpsOfflineSinceRef.current = null;
      } else {
        if (vpsOfflineSinceRef.current === null) {
          vpsOfflineSinceRef.current = now;
          console.warn("[TUNNEL STATUS] offline — starting outage timer");
        } else if (now - vpsOfflineSinceRef.current > VPS_OFFLINE_AUTODISABLE_MS) {
          if (storedValue(AUTO_TRADE_STORAGE_KEY) === "true") {
            console.error("[TUNNEL STATUS] offline >60s → disabling AUTO trading");
            setAutoTradeMode(false);
            localStorage.setItem(AUTO_TRADE_STORAGE_KEY, "false");
            toast({
              title: "AUTO trading disabled",
              description: "VPS unreachable for >60s. Reconnect tunnel and re-arm AUTO mode.",
              variant: "destructive",
            });
          }
        }
      }
      // Independent /status fetch to refresh trading mode (never affects tunnel/backend-online state).
      try {
        const sr = await fetch(`${normalizedVpsBaseUrl}/status`, {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        if (sr.ok) {
          const sd = await sr.json().catch(() => null);
          const autoMode = typeof sd?.auto_mode === "boolean" ? (sd.auto_mode ? "AUTO" : "MANUAL") : "";
          const m = String(sd?.mode ?? sd?.current_mode ?? sd?.trading_mode ?? autoMode).toUpperCase();
          if (m === "AUTO" || m === "MANUAL") setBackendMode(m as "AUTO" | "MANUAL");
          // If backend healthy but didn't report a mode, default to WAIT (not UNKNOWN).
          else setBackendMode((prev) => (prev === "AUTO" || prev === "MANUAL" ? prev : "WAIT"));
        } else {
          setBackendMode((prev) => (prev === "AUTO" || prev === "MANUAL" ? prev : "WAIT"));
        }
      } catch {
        /* mode sync is best-effort; ignore failures */
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
    invokeFunction<{ premium: number; instrument?: { instrumentToken?: string; tradingSymbol?: string; strike?: number; optionType?: string } }>("fetch-option-premium", {
      strike,
      action,
    })
      .then(({ premium, instrument }) => {
        // Freeze the contract at signal-generation time. Execution will NEVER recompute strike/token.
        const optionSide: "CE" | "PE" = action === "BUY" ? "CE" : "PE";
        if (instrument?.instrumentToken && (instrument.strike ?? strike) === strike) {
          signalContractRef.current = {
            signalKey,
            strike,
            optionSide,
            action,
            instrument_token: instrument.instrumentToken,
            tradingSymbol: instrument.tradingSymbol ?? `Nifty ${strike} ${optionSide}`,
            premiumAtSignal: premium,
            spotPriceAtSignal: Number.isFinite(Number(latestData?.ltp)) ? Number(latestData?.ltp) : null,
            lockedAt: Date.now(),
          };
          console.log("[CONTRACT LOCKED]", signalContractRef.current);
        } else {
          console.warn("[CONTRACT LOCK FAILED]", { strike, resolved: instrument });
        }
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

  // v16 SCALPER EXIT ENGINE — tiered trailing + peak give-back + hard SL retry watchdog
  const peakProfitRef = useRef<number>(0);
  const lastSlRetryRef = useRef<number>(0);
  useEffect(() => {
    if (!activeTradePlan?.entryPremium || !activeTradePlan.currentPremium) return;
    const currentStop = activeTradePlan.stopLossPremium ?? activeTradePlan.stopLoss;
    const currentTarget = activeTradePlan.targetPremium ?? activeTradePlan.target;
    const premiumProfit = activeTradePlan.currentPremium - activeTradePlan.entryPremium;
    const stopHit = activeTradePlan.currentPremium <= currentStop;
    const targetHit = activeTradePlan.currentPremium >= currentTarget;

    // HARD SL retry watchdog — keep firing emergencyExit every 1s until trade flattens
    if (activeTradePlan.exitAlertReason) {
      if (stopHit || activeTradePlan.exitAlertReason === "TRAILING_SL") {
        const now = Date.now();
        if (now - lastSlRetryRef.current >= 1_000) {
          lastSlRetryRef.current = now;
          console.warn("[HARD-SL WATCHDOG] re-firing emergencyExit", { premium: activeTradePlan.currentPremium, stop: currentStop });
          emergencyExit(false);
        }
      }
      return;
    }

    // HARD SL — instant market exit on premium breach
    if (stopHit) {
      peakProfitRef.current = 0;
      lastSlRetryRef.current = Date.now();
      const nextPlan = { ...activeTradePlan, exitAlertReason: "TRAILING_SL" as const };
      setExitFlashUntil(Date.now() + 10_000);
      setActiveTradePlan(nextPlan);
      localStorage.setItem(ACTIVE_TRADE_PLAN_STORAGE_KEY, `${todayKey()}:${JSON.stringify(nextPlan)}`);
      console.error("[HARD-SL TRIGGERED]", { premium: activeTradePlan.currentPremium, stop: currentStop });
      emergencyExit(false);
      return;
    }
    if (targetHit) {
      peakProfitRef.current = 0;
      const nextPlan = { ...activeTradePlan, exitAlertReason: "FINAL_TARGET" as const };
      setExitFlashUntil(Date.now() + 10_000);
      setActiveTradePlan(nextPlan);
      localStorage.setItem(ACTIVE_TRADE_PLAN_STORAGE_KEY, `${todayKey()}:${JSON.stringify(nextPlan)}`);
      emergencyExit(false);
      return;
    }

    // Track peak profit for give-back detection
    if (premiumProfit > peakProfitRef.current) peakProfitRef.current = premiumProfit;

    // GIVE-BACK EXIT — peak profit dies, momentum collapse protection
    // Once we've seen ≥8pt profit, exit if price gives back >5pts from peak
    if (peakProfitRef.current >= 8 && premiumProfit < peakProfitRef.current - 5 && premiumProfit > 0) {
      const nextPlan = { ...activeTradePlan, exitAlertReason: "TRAILING_SL" as const };
      setExitFlashUntil(Date.now() + 10_000);
      setActiveTradePlan(nextPlan);
      localStorage.setItem(ACTIVE_TRADE_PLAN_STORAGE_KEY, `${todayKey()}:${JSON.stringify(nextPlan)}`);
      console.warn("[GIVE-BACK EXIT]", { peak: peakProfitRef.current, current: premiumProfit });
      emergencyExit(false);
      return;
    }

    // TIERED TRAILING — professional scalper ladder
    //   +5  → SL to cost (breakeven)
    //   +10 → lock +4
    //   +15 → lock +8
    //   +20 → aggressive: trail every +3pts above
    let lockedSl: number | null = null;
    if (premiumProfit >= 20) {
      const extraSteps = Math.floor((premiumProfit - 20) / PREMIUM_TSL_STEP);
      lockedSl = activeTradePlan.entryPremium + 12 + extraSteps * PREMIUM_TSL_STEP;
    } else if (premiumProfit >= 15) {
      lockedSl = activeTradePlan.entryPremium + 8;
    } else if (premiumProfit >= 10) {
      lockedSl = activeTradePlan.entryPremium + 4;
    } else if (premiumProfit >= 5) {
      lockedSl = activeTradePlan.entryPremium; // breakeven
    }
    if (lockedSl !== null && lockedSl > currentStop) {
      const nextPlan = {
        ...activeTradePlan,
        stopLossPremium: Number(lockedSl.toFixed(2)),
        stopLoss: Number(lockedSl.toFixed(2)),
      };
      setActiveTradePlan(nextPlan);
      setUserSlPoints(formatPremiumInput(lockedSl));
      localStorage.setItem(ACTIVE_TRADE_PLAN_STORAGE_KEY, `${todayKey()}:${JSON.stringify(nextPlan)}`);
      syncStopLossPremium(nextPlan).catch((error) =>
        showRetryToast(error instanceof Error ? error.message : "Server SL modify will retry."),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTradePlan]);

  // Reset peak when trade closes
  useEffect(() => {
    if (!activeTradePlan) {
      peakProfitRef.current = 0;
      lastSlRetryRef.current = 0;
    }
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
    if (!activeTradePlan?.instrument_token || activeTradePlan.exitAlertReason) return;
    const pollPremium = () => {
      if (Date.now() < upstoxBackoffUntilRef.current) return;
      invokeFunction<{ premium: number }>("fetch-option-premium", { instrument_key: activeTradePlan.instrument_token })
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
  }, [activeTradePlan?.instrument_token, activeTradePlan?.exitAlertReason]);

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

  const restoreSavedUpstoxSession = async (force = false): Promise<UpstoxStatus | null> => {
    // De-dupe + cache the session-restore call so frontend re-renders, AI cycles
    // and status checks don't re-spam /system-status (which was causing repeated
    // "Saved Upstox access token found…" toast spam and AI loop restarts).
    const cached = sessionRestoreCacheRef.current;
    if (!force && cached && Date.now() - cached.at < SESSION_RESTORE_TTL_MS) {
      return cached.data;
    }
    if (sessionRestoreInFlightRef.current) return sessionRestoreInFlightRef.current;
    const p = (async () => {
      console.log("[AUTH_REFRESH] restoring saved Upstox session (single-flight)");
      const { data, error } = await supabase.functions.invoke<UpstoxStatus>("system-status", {
        body: { target: "upstox", tokenOnly: true },
      });
      if (error) throw error;
      if (data?.upstox?.ok) {
        localStorage.setItem(UPSTOX_CONNECTED_FLAG_KEY, "true");
        setSystemStatus((prev) => {
          // Avoid unnecessary re-renders if upstox state hasn't changed.
          if (prev?.upstox?.ok === data.upstox.ok && prev?.upstox?.message === data.upstox.message) return prev;
          const gemini = prev?.gemini ?? { ok: false, message: "Run Re-test OpenAI to confirm OpenAI API status." };
          return { ready: true, upstox: data.upstox, gemini, checkedAt: data.checkedAt };
        });
      }
      sessionRestoreCacheRef.current = { at: Date.now(), data: data ?? null };
      return data ?? null;
    })().finally(() => {
      sessionRestoreInFlightRef.current = null;
    });
    sessionRestoreInFlightRef.current = p;
    return p;
  };

  const modeLabel = tradingMode === "scalping" ? "Scalping Mode" : "Sniper Mode";
  const reasoning = useMemo(() => {
    try {
    if (latestSignal) {
      const rules = latestSignal.ruleContext?.rules ?? {};
      const safeAction = latestSignal.action ?? "WAIT";
      const safeStrike = latestSignal.strike ?? "—";
      const safeReason = latestSignal.reason ?? "Waiting for fresh market analysis…";
      const safeConviction = latestSignal.conviction ?? "MEDIUM";
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
      return `Current Mode: ${modeLabel} — ${safeAction === "WAIT" ? "WAITING FOR CONFIRMATION" : `${safeAction} LOCKED`} ${safeStrike} · ${safeConviction} Conviction${triggered ? ` · ${triggered}` : ""} — ${safeReason}`;
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
    } catch (err) {
      console.warn("[AI_REASONING] render fallback", err);
      return "Waiting for fresh market analysis…";
    }
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
      // VPS endpoints match the function name 1:1 (e.g. POST /place-live-order).
      const VPS_PATH_OVERRIDES: Record<string, string> = {};
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
        const upstoxStatus = Number(payload?.upstox_status ?? payload?.upstoxStatus ?? payload?.httpStatusChain?.vpsToUpstox);
        const stage = payload?.stage ?? (!res.ok ? (Number.isFinite(upstoxStatus) ? "UPSTOX_REJECTED" : "VPS_VALIDATION_FAILED") : "VPS_ACCEPTED");
        if (name === "place-live-order") {
          setVpsForensics({
            endpoint: `${normalizedVpsBaseUrl}${path}`,
            method,
            frontendToVpsStatus: res.status,
            vpsToUpstoxStatus: Number.isFinite(upstoxStatus) ? upstoxStatus : null,
            stage,
            trace: Array.isArray(payload?.trace) ? payload.trace : ["PAYLOAD_READY", res.ok ? "VPS_ACCEPTED" : stage].filter(Boolean),
            missingField: payload?.missing_field ?? payload?.missingField ?? null,
            rejectedField: payload?.rejected_field ?? payload?.rejectedField ?? extractRejectedField(payload),
            requestPayload: (body as Record<string, unknown>) ?? null,
            rawResponseBody: payload,
            rawResponseText: text,
            at: Date.now(),
          });
        }
        if (!res.ok) {
          const serverMessage = vpsErrorMessage(payload, res.status);
          const message = serverMessage.includes(UPSTOX_INVALID_CODE_ERROR)
            ? "Invalid Auth code. Upstox authorization codes are single-use; tap Get Code and paste a brand-new code."
            : serverMessage.includes(UPSTOX_INVALID_TOKEN_ERROR) ||
                serverMessage.toLowerCase().includes("upstox oauth reconnect required")
              ? (localStorage.removeItem(UPSTOX_CONNECTED_FLAG_KEY),
                "Upstox OAuth reconnect required. Open API Settings, tap Get Code, finish Upstox login, paste the fresh code, then Connect.")
              : serverMessage;
          recordVpsError(`${method} ${path}`, `${res.status} ${message}`);
          markUpstoxRateLimited(message);
          throw Object.assign(new Error(message), {
            vpsForensics: {
              status: res.status,
              body: payload,
              text,
              requestPayload: body,
              stage,
              upstoxStatus: Number.isFinite(upstoxStatus) ? upstoxStatus : null,
            },
          });
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
    const ceToken = rawData?.ce_instrument_token ?? rawData?.raw_payload?.context?.atm?.ce?.instrument_token ?? rawData?.raw_payload?.context?.atm?.ce?.instrumentKey ?? rawData?.raw_payload?.context?.atm?.ce?.["instrument" + "Token"];
    const peToken = rawData?.pe_instrument_token ?? rawData?.raw_payload?.context?.atm?.pe?.instrument_token ?? rawData?.raw_payload?.context?.atm?.pe?.instrumentKey ?? rawData?.raw_payload?.context?.atm?.pe?.["instrument" + "Token"];
    rawData.raw_payload = rawData.raw_payload ?? {};
    rawData.raw_payload.account = rawData.raw_payload.account ?? {};
    rawData.raw_payload.account.margin = rawData.raw_payload.account.margin ?? {};
    if (availableCash != null) rawData.raw_payload.account.margin.availableCash = availableCash;
    if (todayPnl != null) rawData.raw_payload.account.todayPnl = todayPnl;
    rawData.raw_payload.context = rawData.raw_payload.context ?? {};
    const atmCtx: any = rawData.raw_payload.context.atm ?? {};
    if (Number.isFinite(atmStrikeFlat)) atmCtx.strike = atmStrikeFlat;
    if (Number.isFinite(ceLtpFlat) || rawData?.ce_symbol || ceToken) {
      atmCtx.ce = {
        ...(atmCtx.ce || {}),
        ltp: Number.isFinite(ceLtpFlat) ? ceLtpFlat : atmCtx.ce?.ltp,
        strike: Number.isFinite(atmStrikeFlat) ? atmStrikeFlat : atmCtx.ce?.strike,
        symbol: rawData?.ce_symbol ?? atmCtx.ce?.symbol,
        instrument_token: ceToken ?? atmCtx.ce?.instrument_token,
      };
    }
    if (Number.isFinite(peLtpFlat) || rawData?.pe_symbol || peToken) {
      atmCtx.pe = {
        ...(atmCtx.pe || {}),
        ltp: Number.isFinite(peLtpFlat) ? peLtpFlat : atmCtx.pe?.ltp,
        strike: Number.isFinite(atmStrikeFlat) ? atmStrikeFlat : atmCtx.pe?.strike,
        symbol: rawData?.pe_symbol ?? atmCtx.pe?.symbol,
        instrument_token: peToken ?? atmCtx.pe?.instrument_token,
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
    rawData.ce_instrument_token = ceToken ?? atmCtx.ce?.instrument_token ?? rawData.ce_instrument_token;
    rawData.pe_instrument_token = peToken ?? atmCtx.pe?.instrument_token ?? rawData.pe_instrument_token;
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
      // PRO+++ stability: only force a fresh AI cycle on LARGE spot drift.
      // Do NOT wipe runtime state on small ticks. Backend handles S/R sanitization.
      const anchor = levelsAnchorLtpRef.current;
      if (anchor === null) {
        levelsAnchorLtpRef.current = value;
      } else if (
        Math.abs(value - anchor) > AI_SPOT_DRIFT_TRIGGER_PTS &&
        aiEnabled &&
        !tradingBlocked &&
        !aiAnalysisInFlightRef.current &&
        !isExecutionActive() &&
        !activeTrade &&
        Date.now() - lastForcedAiAtRef.current > 30_000
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
    if (aiAnalysisInFlightRef.current) return;
    if (tradingBlocked) return;
    // ===== SINGLE-POSITION SCALPING LOCK =====
    // While a position is open OR an order is mid-flight, the AI engine must
    // NOT generate new signals / re-evaluate strikes / refresh conviction.
    // Only SL / trailing / exit monitors are allowed to run.
    if (activeTradeRef.current || activeTrade || lockedTradeContextRef.current || isExecutionActive()) {
      console.log("[AI_LOOP] skipped — trade active (monitoring-only mode)");
      return;
    }
    aiAnalysisInFlightRef.current = true;
    console.log("[AI_LOOP] start", new Date().toISOString());
    try {
      if (!upstoxReady) {
        const status = await retestUpstox(true);
        if (!status.upstox.ok) return;
      }
      // PRO+++ stability: do NOT clear runtime state before AI fetch — keep last
      // valid signal/S/R visible while the new analysis is in flight.
      const liveMarket = await fetchLiveNifty(false, true);
      const liveSpot = toNumber(liveMarket?.ltp);
      const payloadTimestamp = liveMarket?.source_timestamp ?? liveMarket?.created_at ?? new Date().toISOString();
      const ai = await withTimeout(
        invokeFunction<{ signal: Signal }>("analyze-with-ai", {
          tradingMode,
          tradingLotSize: normalizedTradingLotSize,
          dailyProfitTarget: normalizedDailyTarget,
          maxDailyLoss: normalizedMaxDailyLoss,
          dailyPnl,
          userTargetPoints: Number(userTargetPoints) || null,
          userSlPoints: Number(userSlPoints) || null,
          spotPrice: liveSpot,
          liveMarket,
          timestamp: new Date().toISOString(),
          payloadTimestamp,
          forceRefresh: true,
        }),
        25_000,
        "OpenAI analysis timed out; continuing Upstox polling.",
      );
      applyFreshSignal(ai.signal, liveSpot);
      console.log("[AI_LOOP] completed", { spot: liveSpot, action: ai?.signal?.action });
    } finally {
      aiAnalysisInFlightRef.current = false;
    }
  };

  const executeTradingSignal = async () => {
    setIsBusy(true);
    try {
      // ===== ACTIVE POSITION LOCK =====
      // Block new entries (AUTO or manual force-trade) while a trade is open
      // or while an order is mid-flight. Unlock only on SL/target/manual exit.
      if (activeTradeRef.current || activeTrade || lockedTradeContextRef.current || isExecutionActive()) {
        toast({
          title: "Trade already active",
          description: "Wait for SL hit, target hit, or manual exit before a new entry.",
          variant: "destructive",
        });
        return;
      }
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

      // Strict staleness check: never reuse old signals for live execution.
      const sigTs = locked?.lockedUntil
        ? locked.lockedUntil - SIGNAL_LOCK_MS
        : Date.parse(lockedSignal.created_at ?? "") || Date.now();
      const sigAgeMs = Date.now() - sigTs;
      if (sigAgeMs > SIGNAL_STALE_MS) {
        const reason = `stale signal — ${Math.round(sigAgeMs / 1000)}s old`;
        setExecutionRootCause("stale signal");
        pushDebug({
          stage: "ERROR",
          level: "error",
          title: "EXECUTION BLOCKED — stale signal",
          detail: reason,
          data: { signalTimestamp: new Date(sigTs).toISOString(), maxAgeSec: SIGNAL_STALE_MS / 1000 },
        });
        toast({ title: "Execution blocked", description: reason, variant: "destructive" });
        return;
      }

      pushDebug({
        stage: "SIGNAL",
        level: "info",
        title: "Executing locked signal...",
        detail: `${lockedSignal.action} ${lockedSignal.strike}`,
        data: { ageMs: sigAgeMs },
      });
      setExecutionRootCause(null);
      toast({ title: "Executing locked signal...", description: `${lockedSignal.action} ${lockedSignal.strike}` });

      const liveMarket = await fetchLiveNifty(true, true);
      const liveSpot = Number(liveMarket?.ltp);
      const ai = { signal: lockedSignal };

      if (!Number.isFinite(liveSpot)) {
        setExecutionRootCause("liveMarket unavailable");
        toast({
          title: "Live price missing",
          description: "Cannot place a live order until Nifty spot is available.",
          variant: "destructive",
        });
        return;
      }
      // Block AUTO/manual execution if locked signal's S/R is implausibly far from live spot.
      const lockedRules: any = lockedSignal.ruleContext?.rules ?? {};
      const lockedSup = toNumber(lockedRules.immediateSupport ?? lockedRules.support15);
      const lockedRes = toNumber(lockedRules.immediateResistance ?? lockedRules.resistance15);
      const srStaleVsLive =
        (lockedSup !== null && Math.abs(liveSpot - lockedSup) > SR_STALE_DISTANCE_PTS) ||
        (lockedRes !== null && Math.abs(liveSpot - lockedRes) > SR_STALE_DISTANCE_PTS);
      if (srStaleVsLive) {
        toast({
          title: "Stale S/R levels — execution blocked",
          description: `Signal levels are >${SR_STALE_DISTANCE_PTS}pt from live spot ${liveSpot.toFixed(2)}. Forcing fresh AI analysis.`,
          variant: "destructive",
        });
        runTradingCycle().catch(() => {});
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
      const sigAny = ai.signal as any;
      // v8: prefer explicit optionSide / direction from AI signal; fall back to BUY→CE / SELL→PE.
      const rawOptionSide = String(sigAny.optionSide ?? sigAny.optionType ?? (ai.signal.action === "BUY" ? "CE" : "PE")).toUpperCase();
      const derivedOptionSideInit: "CE" | "PE" | null = rawOptionSide === "CE" || rawOptionSide === "PE" ? rawOptionSide : null;
      const derivedDirection: "BULLISH" | "BEARISH" = sigAny.direction ?? (ai.signal.action === "BUY" ? "BULLISH" : "BEARISH");
      const vpsEndpointUrl = `${normalizedVpsBaseUrl}/place-live-order`;

      // ===== STRIKE LOCK: resolve frozen contract; NEVER use liveMarket ATM tokens =====
      const lockedSignalKey = `${lockedSignal.created_at ?? ""}-${lockedSignal.action}-${lockedSignal.strike}`;
      let lockedContract = signalContractRef.current;
      if (!lockedContract || lockedContract.signalKey !== lockedSignalKey) {
        if (!suggestedStrike || !derivedOptionSideInit) {
          setExecutionRootCause("strike drift — missing locked strike");
          pushDebug({
            stage: "ERROR", level: "error", title: "STRIKE_DRIFT_BLOCKED",
            detail: `Locked contract missing & signal strike unparseable (${ai.signal.strike})`,
          });
          toast({ title: "STRIKE_DRIFT_BLOCKED", description: "No locked contract for this signal.", variant: "destructive" });
          return;
        }
        try {
          const resp = await invokeFunction<{ premium: number; instrument: { instrumentToken: string; tradingSymbol: string; strike: number; optionType: string } }>(
            "fetch-option-premium",
            { strike: suggestedStrike, action: ai.signal.action },
          );
          if (!resp.instrument?.instrumentToken || Number(resp.instrument.strike) !== suggestedStrike) {
            setExecutionRootCause("strike drift");
            pushDebug({
              stage: "ERROR", level: "error", title: "STRIKE_DRIFT_BLOCKED",
              detail: `Signal strike ${suggestedStrike} ≠ resolved ${resp.instrument?.strike ?? "?"}`,
              data: { signalStrike: suggestedStrike, resolved: resp.instrument },
            });
            toast({ title: "STRIKE_DRIFT_BLOCKED", description: `Signal ${suggestedStrike} ≠ resolved ${resp.instrument?.strike}`, variant: "destructive" });
            return;
          }
          lockedContract = {
            signalKey: lockedSignalKey,
            strike: suggestedStrike,
            optionSide: derivedOptionSideInit,
            action: ai.signal.action as "BUY" | "SELL",
            instrument_token: resp.instrument.instrumentToken,
            tradingSymbol: resp.instrument.tradingSymbol,
            premiumAtSignal: resp.premium,
            spotPriceAtSignal: liveSpot,
            lockedAt: Date.now(),
          };
          signalContractRef.current = lockedContract;
          console.log("[CONTRACT LOCKED — exec-time]", lockedContract);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setExecutionRootCause("strike lock failed");
          pushDebug({ stage: "ERROR", level: "error", title: "STRIKE_DRIFT_BLOCKED", detail: `Contract resolution failed: ${msg}` });
          toast({ title: "Contract lock failed", description: msg, variant: "destructive" });
          return;
        }
      }

      // Hard strike-drift validation
      if (suggestedStrike && lockedContract.strike !== suggestedStrike) {
        setExecutionRootCause("strike drift");
        pushDebug({
          stage: "ERROR", level: "error", title: "STRIKE_DRIFT_BLOCKED",
          detail: `Signal strike ${suggestedStrike} ≠ locked contract strike ${lockedContract.strike}`,
          data: { signalStrike: suggestedStrike, lockedContract },
        });
        toast({ title: "STRIKE_DRIFT_BLOCKED", description: `signal ${suggestedStrike} ≠ locked ${lockedContract.strike}`, variant: "destructive" });
        return;
      }
      const derivedOptionSide: "CE" | "PE" = lockedContract.optionSide;

      // VPS expects snake_case; we send BOTH camelCase + snake_case for compatibility.
      const buildOrderPayload = (attempt: number) => {
        // ALWAYS use locked contract token — never recompute from liveMarket ATM
        const resolvedToken = lockedContract!.instrument_token;
        const orderPayload: Record<string, unknown> & { instrument_token?: string | null } = {
          // ---- AI / signal context ----
          action: ai.signal.action,
          signal_action: ai.signal.action,
          direction: derivedDirection,
          optionSide: derivedOptionSide,
          option_side: derivedOptionSide,
          // ---- Execution side (broker leg) ----
          transactionType: "BUY" as const,
          transaction_type: "BUY" as const,
          execution_side: "BUY" as const,
          // ---- Instrument (LOCKED at signal time) ----
          instrument_token: resolvedToken,
          tradingSymbol: lockedContract!.tradingSymbol,
          ce_instrument_token: liveMarket.ce_instrument_token ?? null,
          pe_instrument_token: liveMarket.pe_instrument_token ?? null,
          // ---- Trade params ----
          spotPrice: liveSpot,
          spotPriceAtSignal: lockedContract!.spotPriceAtSignal,
          strike: lockedContract!.strike,
          quantity: suggestedQuantity,
          tradingLotSize: normalizedTradingLotSize,
          effectiveLotSize: ai.signal.effectiveLotSize,
          targetPremiumPoints: DEFAULT_PREMIUM_TARGET_POINTS,
          stopLossPremiumPoints: DEFAULT_PREMIUM_SL_POINTS,
          maxSlippagePct: execSettings.slippagePct,
          riskPoints: sigAny.riskPoints ?? undefined,
          rrMultiplier: sigAny.rrMultiplier ?? undefined,
          preferredProduct: "I" as const,
          product: "I" as const,
          order_type: "MARKET" as const,
          validity: "DAY" as const,
          price: 0,
          trigger_price: 0,
          disclosed_quantity: 0,
          is_amo: false,
          retryAttempt: attempt,
        };
        return orderPayload;
      };
      const validateOrderPayload = (payload: Record<string, unknown>) => {
        const missing: string[] = [];
        if (!isPresent(payload.instrument_token)) missing.push("instrument_token");
        if (!isPositiveNumber(payload.quantity)) missing.push("quantity");
        if (!isPresent(payload.action)) missing.push("action");
        if (!isPresent(payload.transaction_type)) missing.push("transaction_type");
        if (!isPresent(payload.transactionType)) missing.push("transactionType");
        if (!isPresent(payload.product)) missing.push("product");
        if (!isPresent(payload.order_type)) missing.push("order_type");
        if (!isPresent(payload.validity)) missing.push("validity");
        if (!isPositiveNumber(payload.strike)) missing.push("strike");
        if (payload.optionSide !== "CE" && payload.optionSide !== "PE") missing.push("optionSide");
        if (payload.transaction_type !== "BUY") missing.push("transaction_type_invalid");
        if (payload.product !== "I" && payload.product !== "D") missing.push("product_invalid");
        if (payload.order_type !== "MARKET" && payload.order_type !== "LIMIT" && payload.order_type !== "SL" && payload.order_type !== "SL-M") missing.push("order_type_invalid");
        if (payload.validity !== "DAY" && payload.validity !== "IOC") missing.push("validity_invalid");
        // Strict locked-contract guard: payload MUST carry the frozen instrument_token
        if (payload.instrument_token !== lockedContract!.instrument_token) {
          missing.push("locked_token_mismatch");
        }
        if (Number(payload.strike) !== lockedContract!.strike) {
          missing.push("locked_strike_mismatch");
        }
        return missing;
      };
      const updatePayloadInspector = (payload: Record<string, unknown> | null, retryAttempt: number, missingFields: string[] = []) => {
        const execStrike = payload ? Number(payload.strike) : null;
        setPayloadInspector({
          signalTimestamp: new Date(sigTs).toISOString(),
          signalAgeSec: Math.max(0, Math.round((Date.now() - sigTs) / 1000)),
          liveSpotPrice: liveSpot,
          suggestedStrike,
          derivedOptionSide,
          action: ai.signal.action,
          transactionType: "BUY",
          quantity: suggestedQuantity,
          ce_instrument_token: liveMarket.ce_instrument_token ?? null,
          pe_instrument_token: liveMarket.pe_instrument_token ?? null,
          instrument_token: (payload?.instrument_token as string | null | undefined) ?? null,
          vpsEndpointUrl,
          retryAttempt,
          orderPayload: payload,
          missingFields,
          signalStrike: suggestedStrike ?? lockedContract?.strike ?? null,
          executedStrike: execStrike,
          strikeMatch: execStrike !== null && suggestedStrike !== null ? execStrike === suggestedStrike : null,
          premiumAtSignal: lockedContract?.premiumAtSignal ?? null,
          premiumAtFill: null,
          lockedTradingSymbol: lockedContract?.tradingSymbol ?? null,
          lockedInstrumentToken: lockedContract?.instrument_token ?? null,
        });
      };
      const preflightPayload = buildOrderPayload(1);
      const preflightMissing = validateOrderPayload(preflightPayload);
      updatePayloadInspector(preflightPayload, 1, preflightMissing);
      console.log("[LIVE MARKET]", liveMarket);
      console.log("[DERIVED SIDE]", derivedOptionSide);
      console.log("[FINAL VPS PAYLOAD]", preflightPayload);
      if (preflightMissing.length > 0) {
        const reason = preflightMissing[0] === "optionSide" ? "invalid option side" : `${preflightMissing[0]} missing`;
        setExecutionRootCause(reason);
        pushDebug({
          stage: "ERROR",
          level: "error",
          title: `EXECUTION BLOCKED — ${reason}`,
          detail: `Missing required payload field(s): ${preflightMissing.join(", ")}`,
          data: { missingFields: preflightMissing, rejectedPayload: preflightPayload, liveMarket },
        });
        toast({ title: "Execution blocked", description: `Missing required field: ${preflightMissing[0]}`, variant: "destructive" });
        return;
      }
      pushDebug({
        stage: "ORDER",
        level: "info",
        title: "PAYLOAD_READY",
        detail: `VPS payload ready · ${derivedOptionSide} ${suggestedStrike ?? "ATM"} · product ${preflightPayload.product}`,
        data: preflightPayload,
      });

      // ====== Execution state machine + retry queue (3 attempts, expo backoff) ======
      const setExecState = (s: ExecutionState, err: string | null = null) => {
        executionStateRef.current = s;
        setExecutionState(s);
        setExecutionError(err);
      };
      setExecState("PENDING");
      console.log("[VPS CONNECT] target", normalizedVpsBaseUrl);

      let liveOrder: LiveOrderResult | null = null;
      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= EXEC_MAX_ATTEMPTS; attempt++) {
        setExecutionAttempt(attempt);
        setExecState("SENDING");
        // Extend signal lock so AI loop cannot replace the in-flight signal during retries.
        if (signalLockRef.current) {
          signalLockRef.current.lockedUntil = Date.now() + SIGNAL_LOCK_MS;
        }
        const orderPayload = buildOrderPayload(attempt);
        const attemptMissing = validateOrderPayload(orderPayload);
        updatePayloadInspector(orderPayload, attempt, attemptMissing);
        console.log("[LIVE MARKET]", liveMarket);
        console.log("[DERIVED SIDE]", derivedOptionSide);
        console.log("[FINAL VPS PAYLOAD]", orderPayload);
        if (attemptMissing.length > 0) {
          const reason = attemptMissing[0] === "optionSide" ? "invalid option side" : `${attemptMissing[0]} missing`;
          setExecutionRootCause(reason);
          pushDebug({
            stage: "ERROR",
            level: "error",
            title: `EXECUTION BLOCKED — ${reason}`,
            detail: `Attempt ${attempt}: ${attemptMissing.join(", ")}`,
            data: { missingFields: attemptMissing, rejectedPayload: orderPayload },
          });
          return;
        }
        console.log(`[ORDER SEND] attempt ${attempt}/${EXEC_MAX_ATTEMPTS}`, {
          action: orderPayload.action,
          strike: suggestedStrike,
          instrument_token: orderPayload.instrument_token,
          product: orderPayload.product,
          order_type: orderPayload.order_type,
          validity: orderPayload.validity,
        });
        try {
          if (tunnelOnline) setExecState("VPS_CONNECTED");
          setExecState("EXECUTING");
          pushDebug({
            stage: "ORDER",
            level: "info",
            title: "UPSTOX_REQUEST_SENT",
            detail: `Attempt ${attempt}/${EXEC_MAX_ATTEMPTS} sent to VPS`,
            data: orderPayload,
          });
          liveOrder = await invokeFunction<LiveOrderResult>("place-live-order", orderPayload);
          pushDebug({
            stage: "ORDER",
            level: "success",
            title: liveOrder?.success ? "ORDER_FILLED" : "VPS_ACCEPTED",
            detail: `Frontend → VPS: ${vpsForensics?.frontendToVpsStatus ?? 200}${vpsForensics?.vpsToUpstoxStatus ? ` · VPS → Upstox: ${vpsForensics.vpsToUpstoxStatus}` : ""}`,
          });
          break;
        } catch (err) {
          lastErr = err;
          const msg = err instanceof Error ? err.message : String(err);
          const forensic = (err as Error & { vpsForensics?: { status?: number; body?: Record<string, unknown>; requestPayload?: Record<string, unknown>; stage?: string; upstoxStatus?: number | null } }).vpsForensics;
          const failedFieldRaw = forensic?.body?.missing_field ?? forensic?.body?.missingField ?? forensic?.body?.rejected_field ?? forensic?.body?.rejectedField ?? extractRejectedField(forensic?.body ?? msg);
          const failedField = failedFieldRaw ? String(failedFieldRaw) : null;
          const stage = forensic?.stage ?? (msg.toLowerCase().includes("upstox") ? "UPSTOX_REJECTED" : "VPS_VALIDATION_FAILED");
          setExecutionRootCause(failedField ? `${failedField.includes("invalid") ? "Rejected" : "Missing"} field: ${failedField}` : classifyExecutionRootCause(msg));
          pushDebug({
            stage: "ERROR",
            level: "error",
            title: stage,
            detail: `Frontend → VPS: ${forensic?.status ?? "network"}${forensic?.upstoxStatus ? ` · VPS → Upstox: ${forensic.upstoxStatus}` : " · VPS validation failed before Upstox call"}`,
            data: { message: msg, failedField, rawVpsResponse: forensic?.body, rejectedPayload: forensic?.requestPayload },
          });
          console.warn(`[ORDER RETRY] attempt ${attempt} failed:`, msg);
          if (attempt < EXEC_MAX_ATTEMPTS) {
            setExecState("FAILED", msg);
            await new Promise((r) => setTimeout(r, EXEC_BACKOFF_MS[attempt - 1] ?? 4_000));
          } else {
            console.error("[ORDER FAIL] giving up after", attempt, "attempts:", msg);
          }
        }
      }

      if (!liveOrder) {
        const msg = lastErr instanceof Error ? lastErr.message : String(lastErr ?? "unknown");
        setExecutionRootCause(classifyExecutionRootCause(msg));
        setActiveTradePlan(null);
        localStorage.removeItem(ACTIVE_TRADE_PLAN_STORAGE_KEY);
        setExecState("FAILED", msg);
        pushDebug({
          stage: "ERROR",
          level: "error",
          title: "ORDER FAILED (retries exhausted)",
          detail: msg,
        });
        toast({
          title: "Live execution failed",
          description: `${msg} — signal kept; will retry on next cycle.`,
          variant: "destructive",
        });
        return;
      }

      setLastExecution(liveOrder);
      if (!liveOrder.success) {
        setExecState("FAILED", liveOrder.error ?? "blocked");
        const ed = liveOrder.errorDetails;
        const lastAttempt = ed?.attempts?.slice(-1)[0];
        const upstoxReason = ed?.reason ?? liveOrder.details ?? lastAttempt?.error ?? "blocked";
        setExecutionRootCause(classifyExecutionRootCause(`${liveOrder.error ?? ""} ${upstoxReason}`));
        pushDebug({
          stage: "ERROR",
          level: "error",
          title: `ORDER REJECTED — ${liveOrder.error ?? "Upstox"}`,
          detail: upstoxReason,
          data: {
            execution: liveOrder.execution,
            slippage: liveOrder.slippage,
            liquidity: liveOrder.liquidity,
            failedField: ed?.failedField ?? null,
            rejectedPayload: ed?.rejectedPayload ?? lastAttempt?.payload ?? null,
            attempts: ed?.attempts ?? liveOrder.entryAttempts ?? [],
          },
        });
        toast({
          title: liveOrder.error ?? "Live order blocked",
          description: upstoxReason,
          variant: "destructive",
        });
        return;
      }
      // ===== Order accepted by VPS/Upstox — DO NOT mark as FILLED until broker confirms =====
      setExecState("ORDER_SENT");
      const brokerOrderId: string | null =
        (liveOrder as any).order?.data?.order_id ??
        (liveOrder as any).order?.order_id ??
        (liveOrder as any).order_id ??
        null;
      // v8: entryPremium fallback chain (some failure-paths only return fillPrice/optionLtp)
      const resolvedEntryPremium =
        (liveOrder as any).entryPremium ?? liveOrder.fillPrice ?? liveOrder.slippage?.fillPrice ?? liveOrder.optionLtp ?? 0;
      (liveOrder as any).entryPremium = resolvedEntryPremium;
      pushDebug({
        stage: "ORDER",
        level: "success",
        title: "ORDER_ACCEPTED",
        detail: `${liveOrder.instrument.tradingSymbol} · qty ${liveOrder.quantity} · ${liveOrder.productUsed ?? "I"}/${liveOrder.orderTypeUsed ?? "MARKET"} · order_id=${brokerOrderId ?? "—"}`,
        data: {
          orderId: brokerOrderId,
          instrument: liveOrder.instrument,
          productUsed: liveOrder.productUsed,
          orderTypeUsed: liveOrder.orderTypeUsed,
        },
      });
      console.log("[POSITION] ORDER_ACCEPTED — awaiting broker fill confirmation", {
        order_id: brokerOrderId,
        orderPlaced: liveOrder.execution?.orderPlaced,
        orderFilled: liveOrder.execution?.orderFilled,
        orderStatus: liveOrder.execution?.orderStatus,
      });
      setExecState("ORDER_ACCEPTED");

      // Lock lifecycle so AI loop cannot generate new signals while we wait for fill.
      // IMPORTANT: activeTradePlan stays NULL until broker reports COMPLETE so SL/trailing
      // effects (which guard on activeTradePlan) cannot fire on a non-existent position.
      activeTradeRef.current = true; // synchronous race-safe flip
      setActiveTrade(true);
      localStorage.setItem(ACTIVE_TRADE_STORAGE_KEY, `${todayKey()}:true`);

      // ===== CAPTURE IMMUTABLE LOCKED TRADE CONTEXT =====
      // Frozen snapshot of the entire decision so UI panels stop mutating until exit.
      const lockedRulesSnap = (lockedSignal?.ruleContext?.rules ?? {}) as any;
      const lockedSnapshot: LockedTradeContext = {
        action: lockedSignal!.action as "BUY" | "SELL",
        strike: lockedContract!.strike,
        optionSide: lockedContract!.optionSide,
        tradingSymbol: lockedContract!.tradingSymbol,
        instrument_token: lockedContract!.instrument_token,
        confidenceSnapshot: Number(lockedRulesSnap?.confidenceScore ?? 0),
        reasoningSnapshot: String(lockedSignal?.reason ?? ""),
        supportSnapshot: Number.isFinite(lockedRulesSnap?.immediateSupport)
          ? Number(lockedRulesSnap.immediateSupport)
          : Number.isFinite(lockedRulesSnap?.support15) ? Number(lockedRulesSnap.support15) : null,
        resistanceSnapshot: Number.isFinite(lockedRulesSnap?.immediateResistance)
          ? Number(lockedRulesSnap.immediateResistance)
          : Number.isFinite(lockedRulesSnap?.resistance15) ? Number(lockedRulesSnap.resistance15) : null,
        stopLossPremium: Number(liveOrder.stopLossPremium ?? 0),
        targetPremium: Number(liveOrder.targetPremium ?? 0),
        entryPremium: Number(resolvedEntryPremium ?? 0),
        signalCreatedAt: lockedSignal?.created_at ?? null,
        lockedAt: Date.now(),
      };
      lockedTradeContextRef.current = lockedSnapshot;
      setLockedTradeContext(lockedSnapshot);
      console.log("[LOCKED_TRADE_CONTEXT] captured", lockedSnapshot);


      // Strike-drift forensic snapshot (uses what Upstox reports back, even before fill)
      const executedSymbol = liveOrder.instrument?.tradingSymbol ?? "";
      const executedStrike = parseSuggestedStrike(executedSymbol) ?? Number(liveOrder.instrument?.strike);
      if (Number.isFinite(executedStrike) && lockedContract && executedStrike !== lockedContract.strike) {
        pushDebug({
          stage: "ERROR", level: "error", title: "STRIKE_DRIFT_DETECTED_POST_FILL",
          detail: `Locked ${lockedContract.strike} ≠ executed ${executedStrike} (${executedSymbol})`,
          data: { lockedContract, executed: liveOrder.instrument },
        });
        toast({ title: "⚠ Strike drift detected post-fill", description: `Locked ${lockedContract.strike} ≠ executed ${executedStrike}`, variant: "destructive" });
      }
      setPayloadInspector((prev) => prev ? {
        ...prev,
        executedStrike: Number.isFinite(executedStrike) ? executedStrike : prev.executedStrike,
        strikeMatch: Number.isFinite(executedStrike) && lockedContract ? executedStrike === lockedContract.strike : prev.strikeMatch,
        premiumAtFill: liveOrder.entryPremium ?? null,
      } : prev);

      const finalizeFilledTrade = (confirmedFillPx: number, confirmedQty: number, source: "vps" | "poll") => {
        const fillPx = Number.isFinite(confirmedFillPx) && confirmedFillPx > 0 ? confirmedFillPx : resolvedEntryPremium;
        const qty = Number.isFinite(confirmedQty) && confirmedQty > 0 ? confirmedQty : liveOrder!.quantity;
        const tSymbol = liveOrder!.instrument?.tradingSymbol ?? lockedContract?.tradingSymbol ?? "UNKNOWN_SYMBOL";
        if (!tSymbol || tSymbol === "UNKNOWN_SYMBOL") {
          console.warn("[POSITION] finalize blocked — missing tradingSymbol on broker fill");
        }
        const shouldUseManualExitPrices =
          suggestedEntryPremium !== null && Math.abs(suggestedEntryPremium - fillPx) <= 1;
        const targetPremium =
          shouldUseManualExitPrices && Number(userTargetPoints) ? Number(userTargetPoints) : liveOrder!.targetPremium;
        const stopLossPremium =
          shouldUseManualExitPrices && Number(userSlPoints) ? Number(userSlPoints) : liveOrder!.stopLossPremium;
        const targetPoints = Math.abs(targetPremium - fillPx);
        const slPoints = Math.abs(fillPx - stopLossPremium);

        pushDebug({
          stage: "FILL",
          level: "success",
          title: "ORDER_FILLED",
          detail: `${source === "poll" ? "(broker COMPLETE) " : ""}Fill ₹${fillPx.toFixed(2)} · qty ${qty} · slippage ${liveOrder!.slippage?.slippagePct?.toFixed(2) ?? "—"}%`,
          data: { fillPrice: fillPx, qty, source, orderId: brokerOrderId },
        });
        if (liveOrder!.execution?.slActive) {
          pushDebug({
            stage: "SL", level: "success", title: "SL ACTIVE",
            detail: `Trigger ₹${liveOrder!.slTriggerPrice?.toFixed(2) ?? "—"} · Limit ₹${liveOrder!.slLimitPrice?.toFixed(2) ?? "—"}`,
            data: { slType: liveOrder!.slType, slOrderId: liveOrder!.slOrderId },
          });
        } else {
          pushDebug({
            stage: "ERROR", level: "warn", title: "SL NOT REGISTERED",
            detail: "Server SL not registered. Manual exit may be required.",
          });
        }

        const plan: NonNullable<ActiveTradePlan> = {
          action: ai.signal.action as "BUY" | "SELL",
          entry: liveSpot,
          target: targetPremium,
          stopLoss: stopLossPremium,
          strike: tSymbol,
          quantity: qty,
          initialTargetPoints: targetPoints,
          initialSlPoints: slPoints,
          instrument_token: liveOrder!.instrument_token ?? (liveOrder as any)["instrument" + "Token"],
          slOrderId: liveOrder!.slOrderId,
          entryPremium: fillPx,
          currentPremium: fillPx,
          targetPremium,
          stopLossPremium,
          lastSyncedStopLossPremium: liveOrder!.stopLossPremium,
          tradingSymbol: lockedContract?.tradingSymbol ?? tSymbol,
          optionSide: lockedContract?.optionSide ?? derivedOptionSide,
          signalStrike: lockedContract?.strike ?? suggestedStrike ?? undefined,
          executedStrike: Number.isFinite(executedStrike) ? executedStrike : undefined,
          entryPremiumSnapshot: lockedContract?.premiumAtSignal,
          spotPriceAtSignal: lockedContract?.spotPriceAtSignal ?? undefined,
        };
        if (!userEditedExitsRef.current) {
          setUserTargetPoints(formatPremiumInput(targetPremium));
          setUserSlPoints(formatPremiumInput(stopLossPremium));
        }
        const nextCount = Math.min(MAX_TRADES_PER_DAY, executedTrades + 1);
        setExecutedTrades(nextCount);
        setActiveTradePlan(plan);
        localStorage.setItem(TRADE_COUNT_STORAGE_KEY, `${todayKey()}:${nextCount}`);
        localStorage.setItem(ACTIVE_TRADE_PLAN_STORAGE_KEY, `${todayKey()}:${JSON.stringify(plan)}`);
        setExecState("FILLED");
        toast({
          title: "ORDER FILLED",
          description: `${tSymbol} · Entry ₹${fillPx.toFixed(2)} · SL ₹${stopLossPremium.toFixed(2)}.`,
        });
      };

      const unlockLifecycle = (reason: string) => {
        fillPollRef.current.cancelled = true;
        fillPollRef.current.orderId = null;
        activeTradeRef.current = false;
        setActiveTrade(false);
        setActiveTradePlan(null);
        lockedTradeContextRef.current = null;
        setLockedTradeContext(null);
        localStorage.removeItem(ACTIVE_TRADE_STORAGE_KEY);
        localStorage.removeItem(ACTIVE_TRADE_PLAN_STORAGE_KEY);
        signalContractRef.current = null;
        console.log("[POSITION] lifecycle unlocked —", reason);
      };

      // Fast-path: VPS already confirmed broker fill in the initial response.
      const vpsConfirmedFill =
        liveOrder.execution?.orderFilled === true &&
        Number(resolvedEntryPremium) > 0 &&
        Number(liveOrder.quantity) > 0 &&
        Boolean(liveOrder.instrument?.tradingSymbol);

      if (vpsConfirmedFill) {
        finalizeFilledTrade(resolvedEntryPremium, liveOrder.quantity, "vps");
        return;
      }

      // ===== WAITING_FOR_FILL — poll broker until COMPLETE / REJECTED / CANCELLED / timeout =====
      setExecState("WAITING_FOR_FILL");
      pushDebug({
        stage: "FILL", level: "warn", title: "WAITING_FOR_FILL",
        detail: `Broker has not confirmed fill yet · status=${liveOrder.execution?.orderStatus ?? "unknown"} · order_id=${brokerOrderId ?? "—"}`,
      });

      if (!brokerOrderId) {
        // No order id to poll — treat as fill-timeout and abort cleanly.
        pushDebug({
          stage: "ERROR", level: "error", title: "FILL_TIMEOUT",
          detail: "Broker did not return an order_id; cannot poll for fill. Lifecycle unlocked.",
        });
        toast({ title: "Fill timeout", description: "No broker order_id returned; cancelling lifecycle.", variant: "destructive" });
        unlockLifecycle("missing order_id");
        return;
      }

      // Cancel any prior poll, start a fresh one
      fillPollRef.current = { cancelled: false, orderId: brokerOrderId };
      const pollCtx = fillPollRef.current;

      (async () => {
        for (let attempt = 1; attempt <= FILL_POLL_MAX_ATTEMPTS; attempt++) {
          if (pollCtx.cancelled || pollCtx.orderId !== brokerOrderId) {
            console.log("[POSITION] poll cancelled", { attempt });
            return;
          }
          await new Promise((r) => setTimeout(r, FILL_POLL_INTERVAL_MS));
          if (pollCtx.cancelled || pollCtx.orderId !== brokerOrderId) return;
          try {
            const statusResp = await invokeFunction<{
              success: boolean;
              status?: string;
              isFilled?: boolean;
              isRejected?: boolean;
              isCancelled?: boolean;
              isPending?: boolean;
              average_price?: number;
              filled_quantity?: number;
              trading_symbol?: string | null;
              raw?: unknown;
              error?: string;
            }>("check-order-status", { order_id: brokerOrderId });

            if (pollCtx.cancelled || pollCtx.orderId !== brokerOrderId) return;

            console.log("[POSITION] poll", attempt, statusResp?.status, {
              avg: statusResp?.average_price,
              filled: statusResp?.filled_quantity,
            });

            if (statusResp?.isFilled) {
              finalizeFilledTrade(
                Number(statusResp.average_price ?? resolvedEntryPremium),
                Number(statusResp.filled_quantity ?? liveOrder!.quantity),
                "poll",
              );
              return;
            }
            if (statusResp?.isRejected) {
              pushDebug({
                stage: "ERROR", level: "error", title: "ORDER_REJECTED",
                detail: `Broker rejected order ${brokerOrderId}`,
                data: statusResp?.raw as Record<string, unknown> | undefined,
              });
              setExecState("REJECTED", "Broker rejected order");
              toast({ title: "Order rejected", description: `Broker rejected ${brokerOrderId}.`, variant: "destructive" });
              unlockLifecycle("REJECTED");
              return;
            }
            if (statusResp?.isCancelled) {
              pushDebug({
                stage: "ERROR", level: "warn", title: "ORDER_CANCELLED",
                detail: `Broker cancelled order ${brokerOrderId}`,
                data: statusResp?.raw as Record<string, unknown> | undefined,
              });
              setExecState("CANCELLED", "Broker cancelled order");
              toast({ title: "Order cancelled", description: `Broker cancelled ${brokerOrderId}.`, variant: "destructive" });
              unlockLifecycle("CANCELLED");
              return;
            }
            // still pending → loop
          } catch (err) {
            console.warn("[POSITION] poll error attempt", attempt, err);
            // Soft-fail and retry on transient errors
          }
        }
        // Timed out waiting for fill — auto-cancel the order and unlock lifecycle
        if (pollCtx.cancelled || pollCtx.orderId !== brokerOrderId) return;
        pushDebug({
          stage: "ERROR", level: "error", title: "FILL_TIMEOUT",
          detail: `Broker did not confirm fill within ${(FILL_POLL_INTERVAL_MS * FILL_POLL_MAX_ATTEMPTS) / 1000}s · order_id=${brokerOrderId}`,
        });
        toast({ title: "Fill timeout", description: "Auto-cancelling stale order and unlocking lifecycle.", variant: "destructive" });
        try {
          await invokeFunction("emergency-exit", { lockForDay: false, slOrderId: liveOrder!.slOrderId });
        } catch (err) {
          console.warn("[POSITION] emergency-exit on timeout failed", err);
        }
        setExecState("CANCELLED", "Fill timeout");
        unlockLifecycle("FILL_TIMEOUT");
      })();

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
      // Reset transient execution state after a short delay so the UI shows
      // FILLED/FAILED briefly before returning to IDLE.
      window.setTimeout(() => {
        const s = executionStateRef.current;
        if (s === "FILLED" || s === "FAILED" || s === "REJECTED" || s === "CANCELLED") {
          executionStateRef.current = "IDLE";
          setExecutionState("IDLE");
        }
      }, 4_000);
    }
  };

  const emergencyExit = async (lockForDay = false) => {
    setIsBusy(true);
    try {
      fillPollRef.current.cancelled = true;
      fillPollRef.current.orderId = null;
      await invokeFunction("emergency-exit", { lockForDay, slOrderId: activeTradePlan?.slOrderId });
      const nextCooldown = Date.now() + COOLDOWN_MS;
      activeTradeRef.current = false;
      setActiveTrade(false);
      setActiveTradePlan(null);
      lockedTradeContextRef.current = null;
      setLockedTradeContext(null);
      signalContractRef.current = null;
      lastSignalAutofillRef.current = "";
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

  // Keep latest runTradingCycle in a ref so the interval doesn't tear down on
  // every render (dailyPnl, lot size, etc. previously caused the AI loop to
  // restart constantly, making reasoning appear frozen).
  const runTradingCycleRef = useRef(runTradingCycle);
  useEffect(() => {
    runTradingCycleRef.current = runTradingCycle;
  });

  useEffect(() => {
    if (aiIntervalRef.current) clearInterval(aiIntervalRef.current);
    if (session && aiEnabled) {
      console.log("[AI_REASONING] interval started", { intervalMs: AI_REASONING_INTERVAL_MS });
      aiIntervalRef.current = setInterval(() => {
        if (tradingBlocked) return;
        if (activeTradeRef.current || activeTrade || lockedTradeContextRef.current || isExecutionActive()) {
          console.log("[AI_REASONING] tick skipped — position active (monitor-only)");
          return;
        }
        runTradingCycleRef.current().catch((error) => {
          // Do NOT show destructive popup if AI reasoning endpoint fails —
          // the dashboard keeps polling Upstox and shows "Waiting for fresh
          // market analysis…" instead of crashing the UI.
          console.warn(
            "[AI_REASONING] cycle failed — will retry next tick:",
            error instanceof Error ? error.message : error,
          );
        });
      }, AI_REASONING_INTERVAL_MS);
    }
    return () => {
      if (aiIntervalRef.current) {
        clearInterval(aiIntervalRef.current);
        console.log("[AI_REASONING] interval stopped");
      }
    };
  }, [session, aiEnabled, tradingBlocked]);

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
                {executionState !== "IDLE" && (
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 font-mono text-[10px] uppercase ${
                      executionState === "FAILED" || executionState === "REJECTED" || executionState === "CANCELLED"
                        ? "border-loss/40 bg-loss/10 text-loss"
                        : executionState === "FILLED"
                          ? "border-profit/40 bg-profit/10 text-profit"
                          : executionState === "WAITING_FOR_FILL" || executionState === "ORDER_ACCEPTED" || executionState === "ORDER_SENT"
                            ? "border-primary/40 bg-primary/10 text-primary animate-pulse"
                            : "border-warning/40 bg-warning/10 text-warning animate-pulse"
                    }`}
                    title={executionError ?? undefined}
                  >
                    EXEC: {executionState}
                    {executionAttempt > 0 && executionState !== "FILLED" ? ` · ${executionAttempt}/${EXEC_MAX_ATTEMPTS}` : ""}
                  </span>
                )}
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

        {lockedTradeContext && (
          <section className="rounded-lg border-2 border-primary/60 bg-primary/10 p-4 shadow-market animate-pulse-glow">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Radio className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-bold uppercase tracking-[0.22em] text-primary">
                  Active Locked Trade
                </h2>
                <span className="rounded-sm border border-primary/50 bg-primary/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary">
                  TRADE MANAGEMENT MODE
                </span>
              </div>
              <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                signal locked · new signals blocked
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4 lg:grid-cols-6">
              <div>
                <p className="text-[10px] uppercase text-muted-foreground">Direction</p>
                <p className={`font-bold ${lockedTradeContext.action === "BUY" ? "text-profit" : "text-loss"}`}>
                  {lockedTradeContext.action === "BUY" ? "BULLISH" : "BEARISH"} · {lockedTradeContext.optionSide}
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase text-muted-foreground">Contract</p>
                <p className="font-mono font-bold text-foreground">{lockedTradeContext.tradingSymbol}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase text-muted-foreground">Entry</p>
                <p className="font-mono font-bold text-foreground">₹{lockedTradeContext.entryPremium.toFixed(2)}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase text-muted-foreground">Current</p>
                <p className="font-mono font-bold text-foreground">
                  ₹{(activeTradePlan?.currentPremium ?? lockedTradeContext.entryPremium).toFixed(2)}
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase text-muted-foreground">SL · Target</p>
                <p className="font-mono text-[11px] text-foreground">
                  <span className="text-loss">₹{(activeTradePlan?.stopLossPremium ?? lockedTradeContext.stopLossPremium).toFixed(2)}</span>
                  {" · "}
                  <span className="text-profit">₹{(activeTradePlan?.targetPremium ?? lockedTradeContext.targetPremium).toFixed(2)}</span>
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase text-muted-foreground">Trailing · Conf</p>
                <p className="font-mono text-[11px] text-foreground">
                  <span className={activeTradePlan && (activeTradePlan.stopLossPremium ?? 0) > (activeTradePlan.entryPremium ?? 0) - (activeTradePlan.initialSlPoints ?? 0) ? "text-profit" : "text-muted-foreground"}>
                    {activeTradePlan && (activeTradePlan.stopLossPremium ?? 0) > (activeTradePlan.entryPremium ?? 0) - (activeTradePlan.initialSlPoints ?? 0) ? "ACTIVE" : "IDLE"}
                  </span>
                  {" · "}
                  <span className="text-primary">{lockedTradeContext.confidenceSnapshot}</span>
                </p>
              </div>
            </div>
            {lockedTradeContext.reasoningSnapshot && (
              <p className="mt-3 line-clamp-2 rounded border border-primary/20 bg-surface/60 px-2 py-1.5 text-[10px] italic text-muted-foreground">
                "{lockedTradeContext.reasoningSnapshot}"
              </p>
            )}
          </section>
        )}



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
                      // Keep last signal visible; just unlock so new mode can produce a fresh one.
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
                        preferredProduct: "I",
                        product: "I",
                        order_type: "MARKET",
                        validity: "DAY",
                        forceManual: true,
                      });
                      if (!forced.success) throw new Error(forced.error || "Force trade rejected");
                      toast({
                        title: "FORCE TRADE PLACED",
                        description: `${forced.instrument.tradingSymbol} · Entry ₹${forced.entryPremium?.toFixed(2)}`,
                      });
                      activeTradeRef.current = true;
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
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      <Badge className="bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 text-[10px] tracking-wide">
                        ● TRADE ACTIVE
                      </Badge>
                      <Badge className="bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[10px] tracking-wide">
                        🔒 ENTRY LOCKED
                      </Badge>
                      <Badge className="bg-primary/20 text-primary border border-primary/40 text-[10px] tracking-wide">
                        👁 MONITORING POSITION
                      </Badge>
                      <Badge className="bg-muted text-muted-foreground border border-border text-[10px] tracking-wide">
                        AI SIGNALS PAUSED
                      </Badge>
                    </div>
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

              <div className="mb-3 rounded-md border border-border bg-surface p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div>
                    <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Live Order Payload Inspector</p>
                    <p className="text-sm font-semibold text-foreground">Signal → Payload → VPS → Upstox</p>
                  </div>
                  <span className={`rounded-sm border px-2 py-1 text-[10px] font-bold uppercase tracking-wider ${payloadInspector?.missingFields.length ? "border-loss/40 bg-loss/10 text-loss" : "border-profit/40 bg-profit/10 text-profit"}`}>
                    {payloadInspector?.missingFields.length ? "Incomplete" : "Valid"}
                  </span>
                </div>
                {executionRootCause && (
                  <div className="mb-3 rounded-md border border-loss/40 bg-loss/10 p-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-loss">Execution Failure Root Cause</p>
                    <p className="mt-1 text-xs text-foreground">{executionRootCause}</p>
                  </div>
                )}
                {payloadInspector ? (
                  <>
                    {(() => {
                      const op = payloadInspector.orderPayload ?? {};
                      const checks: Array<[string, unknown]> = [
                        ["transaction_type", op.transaction_type],
                        ["instrument_token", payloadInspector.instrument_token],
                        ["quantity", payloadInspector.quantity],
                        ["product", op.product],
                        ["order_type", op.order_type],
                        ["validity", op.validity],
                        ["optionSide", payloadInspector.derivedOptionSide],
                        ["strike", payloadInspector.suggestedStrike],
                      ];
                      const allOk = checks.every(([, v]) => isPresent(v));
                      return (
                        <div className={`mb-3 rounded-md border p-2 ${allOk ? "border-profit/40 bg-profit/5" : "border-loss/40 bg-loss/10"}`}>
                          <p className={`text-[11px] font-semibold uppercase tracking-wider ${allOk ? "text-profit" : "text-loss"}`}>
                            VPS Field Compatibility · {allOk ? "READY" : "BLOCKED"}
                          </p>
                          <div className="mt-1 flex flex-wrap gap-1.5">
                            {checks.map(([k, v]) => (
                              <span key={k} className={`rounded-sm border px-1.5 py-0.5 text-[10px] font-mono ${isPresent(v) ? "border-profit/40 bg-profit/10 text-profit" : "border-loss/50 bg-loss/15 text-loss"}`}>
                                {isPresent(v) ? "✓" : "✗"} {k}
                              </span>
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                    <div className="grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-3">
                      {[
                        ["signal timestamp", payloadInspector.signalTimestamp],
                        ["signal age", payloadInspector.signalAgeSec === null ? null : `${payloadInspector.signalAgeSec}s`],
                        ["live spot price", payloadInspector.liveSpotPrice],
                        ["suggested strike", payloadInspector.suggestedStrike],
                        ["derivedOptionSide", payloadInspector.derivedOptionSide],
                        ["signal_action (AI bias)", payloadInspector.action],
                        ["execution_side (broker)", payloadInspector.orderPayload?.execution_side ?? "BUY"],
                        ["transactionType (camel)", payloadInspector.transactionType],
                        ["transaction_type (snake)", payloadInspector.orderPayload?.transaction_type],
                        ["product", payloadInspector.orderPayload?.product],
                        ["preferredProduct", payloadInspector.orderPayload?.preferredProduct],
                        ["order_type", payloadInspector.orderPayload?.order_type],
                        ["validity", payloadInspector.orderPayload?.validity],
                        ["quantity", payloadInspector.quantity],
                        ["ce_instrument_token", payloadInspector.ce_instrument_token],
                        ["pe_instrument_token", payloadInspector.pe_instrument_token],
                        ["instrument_token", payloadInspector.instrument_token],
                        ["VPS endpoint URL", payloadInspector.vpsEndpointUrl],
                        ["retry attempt", payloadInspector.retryAttempt],
                        ["SIGNAL_STRIKE", payloadInspector.signalStrike],
                        ["EXECUTED_STRIKE", payloadInspector.executedStrike],
                        ["STRIKE_MATCH", payloadInspector.strikeMatch === null ? null : (payloadInspector.strikeMatch ? "✓ MATCH" : "✗ DRIFT")],
                        ["PREMIUM_AT_SIGNAL", payloadInspector.premiumAtSignal],
                        ["PREMIUM_AT_FILL", payloadInspector.premiumAtFill],
                        ["LOCKED_SYMBOL", payloadInspector.lockedTradingSymbol],
                        ["LOCKED_TOKEN", payloadInspector.lockedInstrumentToken],
                      ].map(([label, value]) => {
                        const ok = isPresent(value);
                        return (
                          <div key={String(label)} className={`rounded-sm border p-2 ${ok ? "border-profit/30 bg-profit/5" : "border-loss/40 bg-loss/10"}`}>
                            <p className="uppercase tracking-wider text-muted-foreground">{String(label)}</p>
                            <p className={`mt-1 break-all font-mono font-semibold ${ok ? "text-profit" : "text-loss"}`}>{isPresent(value) ? String(value) : "missing"}</p>
                          </div>
                        );
                      })}
                    </div>
                    <pre className="mt-3 max-h-72 overflow-auto rounded-md border border-border bg-panel p-3 text-[11px] leading-5 text-foreground">
                      {JSON.stringify(payloadInspector.orderPayload, null, 2)}
                    </pre>
                    {vpsForensics && (
                      <div className="mt-3 rounded-md border border-border bg-panel p-3">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">VPS 400 Forensics</p>
                        <div className="mt-2 grid gap-2 text-[11px] sm:grid-cols-2">
                          <div className="rounded-sm border border-border bg-surface p-2">
                            <p className="uppercase tracking-wider text-muted-foreground">HTTP Status Chain</p>
                            <p className={`mt-1 font-mono font-semibold ${vpsForensics.frontendToVpsStatus && vpsForensics.frontendToVpsStatus >= 400 ? "text-loss" : "text-profit"}`}>
                              Frontend → VPS: {vpsForensics.frontendToVpsStatus ?? "network"}
                            </p>
                            <p className={`font-mono font-semibold ${vpsForensics.vpsToUpstoxStatus && vpsForensics.vpsToUpstoxStatus >= 400 ? "text-loss" : "text-muted-foreground"}`}>
                              {vpsForensics.vpsToUpstoxStatus ? `VPS → Upstox: ${vpsForensics.vpsToUpstoxStatus}` : "VPS validation failed before Upstox call"}
                            </p>
                          </div>
                          <div className="rounded-sm border border-border bg-surface p-2">
                            <p className="uppercase tracking-wider text-muted-foreground">Execution Stage</p>
                            <p className="mt-1 font-mono font-semibold text-foreground">{vpsForensics.stage ?? "—"}</p>
                            <p className="mt-1 break-all text-[10px] text-muted-foreground">{vpsForensics.trace.join(" → ")}</p>
                          </div>
                          <div className="rounded-sm border border-border bg-surface p-2">
                            <p className="uppercase tracking-wider text-muted-foreground">Rejected / Missing Field</p>
                            <p className={`mt-1 font-mono font-semibold ${vpsForensics.missingField || vpsForensics.rejectedField ? "text-loss" : "text-muted-foreground"}`}>
                              {vpsForensics.missingField ? `Missing field: ${vpsForensics.missingField}` : vpsForensics.rejectedField ? `Rejected field: ${vpsForensics.rejectedField}` : "Not reported"}
                            </p>
                          </div>
                          <div className="rounded-sm border border-border bg-surface p-2">
                            <p className="uppercase tracking-wider text-muted-foreground">VPS Endpoint</p>
                            <p className="mt-1 break-all font-mono text-foreground">{vpsForensics.method} {vpsForensics.endpoint}</p>
                          </div>
                        </div>
                        <p className="mt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Final VPS-Bound Payload</p>
                        <pre className="mt-1 max-h-56 overflow-auto rounded-sm border border-border bg-surface p-2 text-[10px] leading-4 text-foreground">
                          {JSON.stringify(vpsForensics.requestPayload, null, 2)}
                        </pre>
                        <p className="mt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Raw VPS Response Body</p>
                        <pre className="mt-1 max-h-64 overflow-auto rounded-sm border border-border bg-surface p-2 text-[10px] leading-4 text-foreground">
                          {JSON.stringify(vpsForensics.rawResponseBody ?? vpsForensics.rawResponseText, null, 2)}
                        </pre>
                      </div>
                    )}
                    {lastExecution && !lastExecution.success && (
                      <div className="mt-3 rounded-md border border-loss/40 bg-loss/5 p-2">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-loss">Raw VPS / Upstox Response</p>
                        <pre className="mt-1 max-h-60 overflow-auto text-[10px] leading-4 text-foreground">
{JSON.stringify({
  error: lastExecution.error,
  details: lastExecution.details,
  errorDetails: lastExecution.errorDetails,
  execution: lastExecution.execution,
  entryAttempts: lastExecution.entryAttempts,
  sentPayload: lastExecution.sentPayload,
  upstox_status: lastExecution.upstox_status,
  upstox_response: lastExecution.upstox_response,
}, null, 2)}
                        </pre>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">No live order payload built yet. Execute a signal to inspect the exact VPS request.</p>
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

            <ProEngineStatus
              signal={latestSignal as any}
              activeTrade={activeTrade}
              isExecutionActive={isExecutionActive()}
              exitAlertReason={activeTradePlan?.exitAlertReason ?? null}
              lastTradeAtMs={latestSignal?.created_at ? new Date(latestSignal.created_at).getTime() : null}
              minTradeGapMin={5}
              maxTradesPerDay={8}
              tradesToday={(latestSignal?.ruleContext as any)?.tradesToday ?? 0}
            />

            <EngineDebugPanel signal={latestSignal as any} />



            <section className={`rounded-lg border bg-panel p-5 shadow-market ${aiPanelTone}`}>

              <div className="mb-3 flex items-center gap-2 text-primary">
                <Activity className="h-5 w-5" />
                <h2 className="text-lg font-semibold text-foreground">Live AI Reasoning</h2>
              </div>
              <p className={`min-h-20 rounded-md border bg-surface p-4 text-sm leading-6 ${aiTextTone}`}>
                {(() => {
                  try {
                    const text = typeof reasoning === "string" ? reasoning.trim() : "";
                    return text.length > 0 ? text : "Waiting for fresh market analysis…";
                  } catch {
                    return "Waiting for fresh market analysis…";
                  }
                })()}
              </p>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                  AI Heartbeat: {aiHeartbeat}
                </span>
                <span>
                  Last AI Update:{" "}
                  {lastAiUpdateAt
                    ? new Date(lastAiUpdateAt).toLocaleTimeString("en-IN")
                    : "—"}
                </span>
              </div>
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
              Auto-refresh every 1m · forced re-analysis on &gt;{AI_SPOT_DRIFT_TRIGGER_PTS}pt move or stale S/R
              {srStale ? " · stale levels hidden" : ""}
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
