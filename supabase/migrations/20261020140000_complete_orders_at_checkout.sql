CREATE OR REPLACE FUNCTION public.settle_order(
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
    RAISE EXCEPTION 'GCash amount must equal the order total and the optional reference must contain 4–13 digits';
  ELSIF _payment_method = 'SPLIT' AND
    (COALESCE(_cash_received, 0) < 0
      OR COALESCE(_gcash_amount, 0) <= 0
      OR COALESCE(_cash_received, 0) + COALESCE(_gcash_amount, 0) <> o.total_amount
      OR (normalized_reference IS NOT NULL AND normalized_reference !~ '^[0-9]{4,13}$')) THEN
    RAISE EXCEPTION 'Split tender must equal the total; the optional GCash reference must contain 4–13 digits';
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

CREATE OR REPLACE FUNCTION public.place_order(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  o public.orders;
  existing public.orders;
  it jsonb;
  mi public.menu_items;
  subtotal numeric := 0;
  disc numeric := 0;
  qty int;
  line_price numeric;
  payment_method text := COALESCE(NULLIF(payload->>'payment_method', ''), 'CASH');
  cash_amount numeric := COALESCE(NULLIF(payload->>'cash_received', '')::numeric, 0);
  gcash_amount numeric := COALESCE(NULLIF(payload->>'gcash_amount', '')::numeric, 0);
  gcash_reference text := NULLIF(btrim(payload->>'gcash_reference'), '');
BEGIN
  IF NOT public.has_any_role(auth.uid(), ARRAY['ADMIN','MANAGER','CASHIER']::public.app_role[]) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  SELECT * INTO existing
  FROM public.orders
  WHERE client_id = (payload->>'client_id')::uuid;
  IF existing.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'id', existing.id,
      'order_number', existing.order_number,
      'duplicate', true
    );
  END IF;

  IF payment_method NOT IN ('CASH','GCASH') THEN
    RAISE EXCEPTION 'Select a valid payment method';
  END IF;
  IF payment_method = 'GCASH'
    AND gcash_reference IS NOT NULL
    AND gcash_reference !~ '^[0-9]{4,13}$' THEN
    RAISE EXCEPTION 'GCash reference must contain 4–13 digits when provided';
  END IF;

  FOR it IN SELECT * FROM jsonb_array_elements(payload->'items') LOOP
    SELECT * INTO mi FROM public.menu_items WHERE id = (it->>'menu_item_id')::uuid;
    IF mi.id IS NULL THEN RAISE EXCEPTION 'Unknown menu item'; END IF;
    qty := GREATEST(1, (it->>'quantity')::int);
    line_price := mi.base_price + COALESCE((it->>'modifier_price')::numeric, 0);
    subtotal := subtotal + line_price * qty;
  END LOOP;

  disc := CASE payload->>'discount_type'
    WHEN 'STUDENT' THEN round(subtotal * 0.10, 2)
    WHEN 'SENIOR' THEN round(subtotal * 0.20, 2)
    WHEN 'PROMO' THEN LEAST(subtotal, COALESCE((payload->>'promo_amount')::numeric, 0))
    ELSE 0
  END;

  IF payment_method = 'CASH' THEN
    cash_amount := COALESCE(NULLIF(payload->>'cash_received', '')::numeric, subtotal - disc);
    IF cash_amount < subtotal - disc OR gcash_amount <> 0 OR gcash_reference IS NOT NULL THEN
      RAISE EXCEPTION 'Cash received must cover the total';
    END IF;
  ELSE
    IF cash_amount <> 0 OR gcash_amount NOT IN (0, subtotal - disc) THEN
      RAISE EXCEPTION 'GCash payment must equal the order total';
    END IF;
    gcash_amount := subtotal - disc;
  END IF;

  INSERT INTO public.orders(
    client_id, order_type, customer_name, total_amount, discount_type, discount_amount,
    cashier_id, created_offline, created_at, status, payment_method, cash_received,
    gcash_amount, gcash_reference, payment_reference, settled_at
  )
  VALUES (
    (payload->>'client_id')::uuid,
    (payload->>'order_type')::public.order_type,
    NULLIF(payload->>'customer_name', ''),
    subtotal - disc,
    NULLIF(payload->>'discount_type', ''),
    disc,
    auth.uid(),
    COALESCE((payload->>'offline')::boolean, false),
    COALESCE((payload->>'created_at')::timestamptz, now()),
    'COMPLETED',
    payment_method,
    CASE WHEN payment_method = 'CASH' THEN cash_amount ELSE 0 END,
    CASE WHEN payment_method = 'GCASH' THEN gcash_amount ELSE 0 END,
    gcash_reference,
    gcash_reference,
    now()
  )
  RETURNING * INTO o;

  FOR it IN SELECT * FROM jsonb_array_elements(payload->'items') LOOP
    SELECT * INTO mi FROM public.menu_items WHERE id = (it->>'menu_item_id')::uuid;
    qty := GREATEST(1, (it->>'quantity')::int);
    INSERT INTO public.order_items(
      order_id, menu_item_id, name, station, quantity, modifiers, item_price, item_status
    )
    VALUES (
      o.id, mi.id, mi.name, mi.target_station, qty, it->'modifiers',
      mi.base_price + COALESCE((it->>'modifier_price')::numeric, 0), 'COMPLETED'
    );

    UPDATE public.ingredients i
    SET current_stock = i.current_stock - r.quantity_req * qty
    FROM public.recipe_ingredients r
    WHERE r.menu_item_id = mi.id AND r.ingredient_id = i.id;

    INSERT INTO public.stock_transactions(ingredient_id, change, reason, order_id, user_id)
    SELECT r.ingredient_id, -r.quantity_req * qty, 'SALE', o.id, auth.uid()
    FROM public.recipe_ingredients r
    WHERE r.menu_item_id = mi.id;
  END LOOP;

  INSERT INTO public.order_audit_logs(order_id, employee_id, action, before_state, after_state)
  VALUES (
    o.id,
    auth.uid(),
    'SETTLE',
    jsonb_build_object('settled_at', NULL, 'status', 'PENDING'),
    jsonb_build_object(
      'payment_method', payment_method,
      'cash_received', CASE WHEN payment_method = 'CASH' THEN cash_amount ELSE 0 END,
      'gcash_amount', CASE WHEN payment_method = 'GCASH' THEN gcash_amount ELSE 0 END,
      'gcash_reference', gcash_reference,
      'settled_at', o.settled_at,
      'status', 'COMPLETED'
    )
  );

  RETURN jsonb_build_object('id', o.id, 'order_number', o.order_number, 'duplicate', false);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.place_order(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.place_order(jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
