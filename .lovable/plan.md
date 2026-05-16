# PRO+++ Institutional Scalping Engine — Evolution Patch

This is an **evolution**, not a rewrite. All existing VPS routing, Upstox execution, retry/slippage/liquidity/trailing SL logic, and Supabase tables stay intact. We layer new intelligence + synchronization on top.

---

## 1. Edge Function — `analyze-with-ai/index.ts`

Replace the hard-filter signal logic with a **Weighted Confidence Engine**, while keeping the existing cooldown + VPS/Upstox integration untouched.

### Weighted scoring model
```text
+20  9 EMA > 21 EMA (BUY) / inverse (SELL)
+20  5m trend aligned
+15  Breakout candle (body > 60% range, vol > avg3)
+15  Volume confirmation
+10  Support bounce / Resistance rejection
+10  Stable VIX (12–18)
+5   PCR aligned
+10  Compression breakout (last5 range ≤15 pts)
-10  Upper/lower wick rejection against direction
-10  Weak volume
-15  Extreme VIX (>22)
-15  Fake breakout (close back inside range)
```

### Decision thresholds
- `score ≥ 75` → **HIGH_CONVICTION** signal (full size, wider target 18–20 pts)
- `score 65–74` → **FAST_SCALP** signal (half size, tight SL, target 10–15 pts)
- `score < 65` → `WAIT` with contextual reason

### EMA pullback continuation
If trend is up AND price pulled back to 21 EMA AND a bullish rejection candle formed AND current candle breaks the pullback candle high → allow BUY_CE even mid-zone (score boost +25).

### Hard blocks only for
VPS disconnected, Upstox unavailable, abnormal spike candle (>1.5× ATR), liquidity too low, spread too wide, duplicate active trade, active execution state.

### Cooldowns
- `SIGNAL_COOLDOWN_SEC = 90` (already exists, keep)
- `MIN_TRADE_GAP_MIN = 5` (new — block new entry signal within 5 min of last entry)
- `MAX_TRADES_PER_DAY = 8`
- After 2 losses in a row → 45-min cooldown
- After 1 loss → halve position size for next trade

### Persisted reasoning
Always emit at least one of:
- `WAIT — momentum building`
- `WAIT — EMA pullback forming`
- `WAIT — breakout probability increasing`
- `WAIT — low conviction only`

Never emit empty/null reasoning.

### Response payload additions
```json
{
  "confidenceScore": 78,
  "mode": "HIGH_CONVICTION" | "FAST_SCALP" | "WAIT",
  "regime": "TRENDING" | "CHOPPY" | "COMPRESSION",
  "edgeFactors": ["EMA aligned","Vol confirm","Support bounce"],
  "rejectionReason": "VIX extreme" | null,
  "supportStrength": 0..3,
  "resistanceStrength": 0..3,
  "signalAgeSec": 0,
  "cooldownRemainingSec": 0
}
```
(All existing fields preserved.)

---

## 2. Frontend — `src/pages/Index.tsx`

### Trade State Machine (new module/hook `useTradeState`)
States: `IDLE → ANALYZING → WAITING_CONFIRMATION → SIGNAL_GENERATED → ENTRY_PENDING → ORDER_SENDING → ORDER_FILLED → SL_ACTIVE → TRAILING_ACTIVE → EXIT_PENDING → TRADE_CLOSED → COOLDOWN → IDLE`

Rules enforced in reducer:
- While state ∉ {IDLE, ANALYZING, COOLDOWN}: AI payload **cannot** clear signal, S/R, reasoning, or mode badge.
- Only valid transitions allowed; invalid transitions are logged + ignored.
- State persisted to `sessionStorage` so refresh doesn't wipe execution context.

### Persistence layer
- **Support/Resistance cache**: store last non-null S/R with timestamp. Hold for ≥3 min. Only overwrite if new value comes with `supportStrength` ≥ cached strength OR cache age > 180s.
- **Reasoning cache**: hold for ≥30s. New reasoning replaces only after 30s or on state transition.
- **Last signal cache**: preserve last valid signal across AI polls; only cleared by state machine on TRADE_CLOSED.

### Frequency control (client-side guard)
- Block new entry submission if `now - lastEntryAt < 5min`
- Block if `tradesToday >= 8`
- Block if state machine isn't in IDLE/COOLDOWN

### Dashboard UI additions (single new section, no removal)
Compact pro panel with:
1. **Confidence meter** (0–100 radial)
2. **Trade state badge** (color-coded by phase)
3. **Signal quality bar**
4. **Regime pill** (TRENDING/CHOPPY/COMPRESSION)
5. **AI Mode pill** (HIGH CONVICTION / FAST SCALP / WAIT)
6. **Signal age timer** (live mm:ss)
7. **Edge factors chips** (active + scored)
8. **Last rejection reason** line
9. **S/R strength dots** (●●○)
10. **Cooldown timer**

All styled via existing tailwind semantic tokens (no new colors hardcoded).

---

## 3. What stays untouched
- `vps-backend/upstox_routes.py` — no changes
- `supabase/functions/place-live-order/index.ts` — no changes
- `supabase/functions/fetch-nifty-data/index.ts` — no changes
- All Supabase tables/RLS
- Trailing SL, slippage exit, SL-LMT fail-safe, liquidity filter, retry wrapper
- Duplicate trade guard, active trade lock
- VPS routing + tunnel logic

---

## 4. Files I'll edit
1. `supabase/functions/analyze-with-ai/index.ts` — weighted engine, modes, payload additions, frequency limits
2. `src/pages/Index.tsx` — state machine, persistence caches, frequency guards, new dashboard panel

No new dependencies. No DB migration. No backend redeploy required beyond the edge function (auto-deploys).

---

## 5. Verification after build
- Check console logs for state transitions, confidence scores, blocked signals
- Confirm S/R + reasoning remain visible during WAIT
- Confirm no signal regeneration < 90s; no new trade < 5min
- Confirm existing place-live-order path still fires with identical payload schema

Approve and I'll implement.