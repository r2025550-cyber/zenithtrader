ALTER TABLE public.trading_api_settings
  ALTER COLUMN upstox_api_key DROP NOT NULL,
  ALTER COLUMN upstox_api_secret DROP NOT NULL,
  ALTER COLUMN openai_api_key DROP NOT NULL;