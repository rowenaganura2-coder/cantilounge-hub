-- Drop the existing overload so Postgres can replace its parameter names too.
DROP FUNCTION IF EXISTS public.settle_order(uuid, text, numeric, numeric, text);

CREATE FUNCTION public.settle_order(
  _order_id uuid,
  _payment_method text,
  _cash_received numeric DEFAULT 0,
  _gcash_amount numeric DEFAULT 0,
  _gcash_reference text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  o public.orders;
  normalized_reference text := NULLIF(btrim(_gcash_reference), '');
BEGIN
  IF NOT public.has_any_role(auth.uid(), ARRAY['ADMIN','MANAGER','CASHIER']::public.app_role[]) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  SELECT * INTO o FROM public.orders WHERE id = _order_id FOR UPDATE;
  IF o.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF o.settled_at IS NOT NULL OR o.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'Order cannot be settled';
  END IF;
  IF _payment_method IS NULL OR _payment_method NOT IN ('CASH','GCASH','SPLIT') THEN
    RAISE EXCEPTION 'Select a valid payment method';
  END IF;
  IF _payment_method = 'CASH' AND
    (COALESCE(_cash_received, 0) < o.total_amount
      OR COALESCE(_gcash_amount, 0) <> 0
      OR normalized_reference IS NOT NULL) THEN
    RAISE EXCEPTION 'Cash received must cover the total';
  ELSIF _payment_method = 'GCASH' AND
    (COALESCE(_cash_received, 0) <> 0
      OR COALESCE(_gcash_amount, 0) <> o.total_amount
      OR (normalized_reference IS NOT NULL AND normalized_reference !~ '^[0-9]{4,13}$')) THEN
    RAISE EXCEPTION 'GCash amount must equal the order total and the optional reference must contain 4-13 digits';
  ELSIF _payment_method = 'SPLIT' AND
    (COALESCE(_cash_received, 0) < 0
      OR COALESCE(_gcash_amount, 0) <= 0
      OR COALESCE(_cash_received, 0) + COALESCE(_gcash_amount, 0) <> o.total_amount
      OR (normalized_reference IS NOT NULL AND normalized_reference !~ '^[0-9]{4,13}$')) THEN
    RAISE EXCEPTION 'Split tender must equal the total; the optional GCash reference must contain 4-13 digits';
  END IF;

  UPDATE public.orders
  SET payment_method = _payment_method,
      cash_received = COALESCE(_cash_received, 0),
      gcash_amount = COALESCE(_gcash_amount, 0),
      gcash_reference = CASE
        WHEN _payment_method IN ('GCASH','SPLIT') THEN normalized_reference
        ELSE NULL
      END,
      payment_reference = CASE
        WHEN _payment_method IN ('GCASH','SPLIT') THEN normalized_reference
        ELSE NULL
      END,
      settled_at = now(),
      status = 'COMPLETED'
  WHERE id = _order_id;

  UPDATE public.order_items
  SET item_status = 'COMPLETED'
  WHERE order_id = _order_id AND item_status <> 'CANCELLED';

  INSERT INTO public.order_audit_logs(order_id, employee_id, action, before_state, after_state)
  VALUES (
    _order_id,
    auth.uid(),
    'SETTLE',
    jsonb_build_object('settled_at', NULL, 'status', o.status),
    jsonb_build_object(
      'payment_method', _payment_method,
      'cash_received', COALESCE(_cash_received, 0),
      'gcash_amount', COALESCE(_gcash_amount, 0),
      'gcash_reference', normalized_reference,
      'settled_at', now(),
      'status', 'COMPLETED'
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.settle_order(uuid, text, numeric, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.settle_order(uuid, text, numeric, numeric, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
