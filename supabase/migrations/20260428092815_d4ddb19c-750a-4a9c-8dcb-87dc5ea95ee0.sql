CREATE POLICY "API settings are backend only"
ON public.trading_api_settings
FOR ALL
TO authenticated
USING (false)
WITH CHECK (false);