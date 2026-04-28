CREATE TABLE public.trading_api_settings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE,
  upstox_api_key TEXT NOT NULL,
  upstox_api_secret TEXT NOT NULL,
  openai_api_key TEXT NOT NULL,
  upstox_access_token TEXT,
  upstox_refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  redirect_uri TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.nifty_market_data (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  symbol TEXT NOT NULL DEFAULT 'NSE_INDEX|Nifty 50',
  ltp NUMERIC(12, 2),
  open_price NUMERIC(12, 2),
  high_price NUMERIC(12, 2),
  low_price NUMERIC(12, 2),
  close_price NUMERIC(12, 2),
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_timestamp TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.ai_trade_signals (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  market_data_id UUID REFERENCES public.nifty_market_data(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  strike TEXT NOT NULL,
  reason TEXT NOT NULL,
  raw_response TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.ai_trading_sessions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT false,
  risk_mode TEXT NOT NULL DEFAULT 'moderate',
  last_run_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.trading_api_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nifty_market_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_trade_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_trading_sessions ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_nifty_market_data_user_created ON public.nifty_market_data(user_id, created_at DESC);
CREATE INDEX idx_ai_trade_signals_user_created ON public.ai_trade_signals(user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_trading_api_settings_updated_at
BEFORE UPDATE ON public.trading_api_settings
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_ai_trading_sessions_updated_at
BEFORE UPDATE ON public.ai_trading_sessions
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE POLICY "Users can view their own market data"
ON public.nifty_market_data
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Users can view their own AI signals"
ON public.ai_trade_signals
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Users can view their own trading session"
ON public.ai_trading_sessions
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Users can update their own trading session"
ON public.ai_trading_sessions
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);