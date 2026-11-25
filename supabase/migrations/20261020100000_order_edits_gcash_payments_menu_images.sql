ALTER TABLE public.menu_items
  ADD COLUMN image_url text;

ALTER TABLE public.orders
  ADD COLUMN payment_method text NOT NULL DEFAULT 'UNPAID'
    CHECK (payment_method IN ('UNPAID', 'CASH', 'GCASH', 'SPLIT')),
  ADD COLUMN cash_received numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN gcash_amount numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN gcash_reference text,
  ADD COLUMN settled_at timestamptz,
  ADD CONSTRAINT orders_gcash_reference_format
    CHECK (gcash_reference IS NULL OR gcash_reference ~ '^[0-9]{4,13}$');

CREATE TABLE public.order_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.staff_profiles(id),
  action text NOT NULL CHECK (action IN ('MODIFY', 'VOID', 'SETTLE', 'COMPLETE')),
  reason text,
  before_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  after_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_audit_logs_order_id_created_at_idx
  ON public.order_audit_logs(order_id, created_at DESC);
ALTER TABLE public.order_audit_logs ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.order_audit_logs TO authenticated;
CREATE POLICY "staff read order audit logs" ON public.order_audit_logs
  FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));

REVOKE UPDATE ON public.orders FROM authenticated;
REVOKE UPDATE ON public.order_items FROM authenticated;

CREATE OR REPLACE FUNCTION public.mark_order_items_ready(_item_ids uuid[], _station public.station)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE changed_count int;
BEGIN
  IF NOT public.has_any_role(
    auth.uid(), ARRAY['ADMIN','MANAGER','CASHIER']::public.app_role[]
  ) AND NOT public.has_role(auth.uid(), _station::text::public.app_role) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  IF COALESCE(cardinality(_item_ids), 0) = 0 THEN
    RAISE EXCEPTION 'Select at least one active ticket item';
  END IF;

  UPDATE public.order_items
  SET item_status = 'READY'
  WHERE id = ANY(_item_ids)
    AND station = _station
    AND item_status IN ('PENDING','IN_PREP');
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  IF changed_count <> cardinality(_item_ids) THEN
    RAISE EXCEPTION 'One or more prep items are no longer active';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION public.sync_order_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE total int; ready int; prep int;
BEGIN
  SELECT count(*) FILTER (WHERE item_status <> 'CANCELLED'),
         count(*) FILTER (WHERE item_status IN ('READY','COMPLETED')),
         count(*) FILTER (WHERE item_status = 'IN_PREP')
    INTO total, ready, prep FROM public.order_items WHERE order_id = NEW.order_id;
  UPDATE public.orders
  SET status = CASE
    WHEN total = 0 THEN 'CANCELLED'::public.order_status
    WHEN ready = total THEN 'READY'::public.order_status
    WHEN prep > 0 OR ready > 0 THEN 'IN_PREP'::public.order_status
    ELSE 'PENDING'::public.order_status
  END
  WHERE id = NEW.order_id AND status NOT IN ('COMPLETED','CANCELLED');
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.modify_order(_order_id uuid, _items jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  o public.orders;
  current_item public.order_items;
  change_item jsonb;
  new_quantity int;
  old_quantity int;
  quantity_delta int;
  new_modifiers jsonb;
  new_price numeric;
  subtotal numeric;
  new_discount numeric;
  recipe record;
  before_items jsonb;
  after_items jsonb;
BEGIN
  IF NOT public.has_any_role(auth.uid(), ARRAY['ADMIN','MANAGER','CASHIER']::public.app_role[]) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  IF jsonb_typeof(_items) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid order items'; END IF;

  SELECT * INTO o FROM public.orders WHERE id = _order_id FOR UPDATE;
  IF o.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF o.settled_at IS NOT NULL OR o.status IN ('COMPLETED','CANCELLED') THEN
    RAISE EXCEPTION 'Only unsettled active orders can be modified';
  END IF;
  IF (SELECT count(*) FROM public.order_items WHERE order_id = _order_id)
    <> jsonb_array_length(_items)
    OR (SELECT count(DISTINCT (value->>'id')) FROM jsonb_array_elements(_items))
    <> jsonb_array_length(_items) THEN
    RAISE EXCEPTION 'Ticket changes must include each line item exactly once';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', id, 'quantity', quantity, 'modifiers', modifiers, 'item_price', item_price,
    'item_status', item_status
  ) ORDER BY id), '[]'::jsonb) INTO before_items
  FROM public.order_items WHERE order_id = _order_id;

  FOR change_item IN SELECT * FROM jsonb_array_elements(_items) LOOP
    SELECT * INTO current_item
    FROM public.order_items
    WHERE id = (change_item->>'id')::uuid AND order_id = _order_id
    FOR UPDATE;
    IF current_item.id IS NULL THEN RAISE EXCEPTION 'Order item not found'; END IF;

    new_quantity := COALESCE((change_item->>'quantity')::int, 0);
    IF new_quantity < 0 THEN RAISE EXCEPTION 'Quantity cannot be negative'; END IF;
    new_modifiers := change_item->'modifiers';
    old_quantity := CASE WHEN current_item.item_status = 'CANCELLED' THEN 0 ELSE current_item.quantity END;
    quantity_delta := new_quantity - old_quantity;

    FOR recipe IN
      SELECT r.ingredient_id, r.quantity_req
      FROM public.recipe_ingredients r
      WHERE r.menu_item_id = current_item.menu_item_id
    LOOP
      IF quantity_delta > 0 THEN
        UPDATE public.ingredients
        SET current_stock = current_stock - recipe.quantity_req * quantity_delta
        WHERE id = recipe.ingredient_id
          AND current_stock >= recipe.quantity_req * quantity_delta;
        IF NOT FOUND THEN RAISE EXCEPTION 'Insufficient stock to increase this item'; END IF;
      ELSE
        UPDATE public.ingredients
        SET current_stock = current_stock - recipe.quantity_req * quantity_delta
        WHERE id = recipe.ingredient_id;
      END IF;
      INSERT INTO public.stock_transactions(ingredient_id, change, reason, order_id, user_id)
      VALUES (
        recipe.ingredient_id,
        -recipe.quantity_req * quantity_delta,
        CASE WHEN quantity_delta > 0 THEN 'ORDER_EDIT' ELSE 'ORDER_EDIT_RESTOCK' END,
        _order_id,
        auth.uid()
      );
    END LOOP;

    SELECT mi.base_price + CASE WHEN new_modifiers->>'milk' = 'oat' THEN 30 ELSE 0 END
      INTO new_price
    FROM public.menu_items mi WHERE mi.id = current_item.menu_item_id;

    UPDATE public.order_items
    SET quantity = GREATEST(new_quantity, 1),
        modifiers = new_modifiers,
        item_price = new_price,
        item_status = CASE
          WHEN new_quantity = 0 THEN 'CANCELLED'::public.order_status
          WHEN quantity_delta <> 0 OR modifiers IS DISTINCT FROM new_modifiers
            THEN 'PENDING'::public.order_status
          ELSE item_status
        END
    WHERE id = current_item.id;
  END LOOP;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', id, 'quantity', quantity, 'modifiers', modifiers, 'item_price', item_price,
    'item_status', item_status
  ) ORDER BY id), '[]'::jsonb),
    COALESCE(sum(item_price * quantity) FILTER (WHERE item_status <> 'CANCELLED'), 0)
  INTO after_items, subtotal
  FROM public.order_items WHERE order_id = _order_id;
  IF subtotal <= 0 THEN
    RAISE EXCEPTION 'Void the entire ticket when no items remain';
  END IF;

  new_discount := CASE o.discount_type
    WHEN 'STUDENT' THEN round(subtotal * 0.10, 2)
    WHEN 'SENIOR' THEN round(subtotal * 0.20, 2)
    WHEN 'PROMO' THEN LEAST(subtotal, o.discount_amount)
    ELSE 0
  END;
  UPDATE public.orders
  SET total_amount = subtotal - new_discount, discount_amount = new_discount
  WHERE id = _order_id;

  INSERT INTO public.order_audit_logs(order_id, employee_id, action, before_state, after_state)
  VALUES (
    _order_id, auth.uid(), 'MODIFY',
    jsonb_build_object('items', before_items, 'total_amount', o.total_amount),
    jsonb_build_object('items', after_items, 'total_amount', subtotal - new_discount)
  );
END $$;

CREATE OR REPLACE FUNCTION public.void_order(_order_id uuid, _reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  o public.orders;
  before_state jsonb;
  recipe record;
BEGIN
  IF NOT public.has_any_role(auth.uid(), ARRAY['ADMIN','MANAGER','CASHIER']::public.app_role[]) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  IF _reason IS NULL OR _reason NOT IN ('Customer Changed Mind','Cashier Misclick','Out of Stock') THEN
    RAISE EXCEPTION 'Select a valid void reason';
  END IF;
  SELECT * INTO o FROM public.orders WHERE id = _order_id FOR UPDATE;
  IF o.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF o.settled_at IS NOT NULL OR o.status IN ('COMPLETED','CANCELLED') THEN
    RAISE EXCEPTION 'Only unsettled active orders can be voided';
  END IF;
  SELECT jsonb_build_object(
    'status', o.status, 'total_amount', o.total_amount,
    'items', COALESCE(jsonb_agg(jsonb_build_object(
      'id', oi.id, 'quantity', oi.quantity, 'modifiers', oi.modifiers, 'item_status', oi.item_status
    )) FILTER (WHERE oi.id IS NOT NULL), '[]'::jsonb)
  ) INTO before_state
  FROM public.order_items oi WHERE oi.order_id = _order_id;

  FOR recipe IN
    SELECT r.ingredient_id, r.quantity_req * oi.quantity AS quantity
    FROM public.order_items oi
    JOIN public.recipe_ingredients r ON r.menu_item_id = oi.menu_item_id
    WHERE oi.order_id = _order_id AND oi.item_status <> 'CANCELLED'
  LOOP
    UPDATE public.ingredients SET current_stock = current_stock + recipe.quantity
    WHERE id = recipe.ingredient_id;
    INSERT INTO public.stock_transactions(ingredient_id, change, reason, order_id, user_id)
    VALUES (recipe.ingredient_id, recipe.quantity, 'ORDER_VOID', _order_id, auth.uid());
  END LOOP;

  UPDATE public.order_items SET item_status = 'CANCELLED' WHERE order_id = _order_id;
  UPDATE public.orders SET status = 'CANCELLED' WHERE id = _order_id;
  INSERT INTO public.order_audit_logs(order_id, employee_id, action, reason, before_state, after_state)
  VALUES (_order_id, auth.uid(), 'VOID', _reason, before_state, '{"status":"CANCELLED"}'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.settle_order(
  _order_id uuid,
  _payment_method text,
  _cash_received numeric DEFAULT 0,
  _gcash_amount numeric DEFAULT 0,
  _gcash_reference text DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  o public.orders;
BEGIN
  IF NOT public.has_any_role(auth.uid(), ARRAY['ADMIN','MANAGER','CASHIER']::public.app_role[]) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  SELECT * INTO o FROM public.orders WHERE id = _order_id FOR UPDATE;
  IF o.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF o.settled_at IS NOT NULL OR o.status IN ('COMPLETED','CANCELLED') THEN
    RAISE EXCEPTION 'Order cannot be settled';
  END IF;
  IF _payment_method IS NULL OR _payment_method NOT IN ('CASH','GCASH','SPLIT') THEN
    RAISE EXCEPTION 'Select a valid payment method';
  END IF;
  IF _payment_method = 'CASH' AND
    (COALESCE(_cash_received, 0) < o.total_amount OR COALESCE(_gcash_amount, 0) <> 0 OR _gcash_reference IS NOT NULL) THEN
    RAISE EXCEPTION 'Cash received must cover the total';
  ELSIF _payment_method = 'GCASH' AND
    (COALESCE(_cash_received, 0) <> 0 OR COALESCE(_gcash_amount, 0) <> o.total_amount
      OR COALESCE(_gcash_reference !~ '^[0-9]{4,13}$', true)) THEN
    RAISE EXCEPTION 'Enter a valid GCash reference number and full amount';
  ELSIF _payment_method = 'SPLIT' AND
    (COALESCE(_cash_received, 0) < 0 OR COALESCE(_gcash_amount, 0) <= 0
      OR COALESCE(_cash_received, 0) + COALESCE(_gcash_amount, 0) <> o.total_amount
      OR COALESCE(_gcash_reference !~ '^[0-9]{4,13}$', true)) THEN
    RAISE EXCEPTION 'Split tender must equal the total and include a valid GCash reference';
  END IF;

  UPDATE public.orders
  SET payment_method = _payment_method,
      cash_received = COALESCE(_cash_received, 0),
      gcash_amount = COALESCE(_gcash_amount, 0),
      gcash_reference = CASE WHEN _payment_method IN ('GCASH','SPLIT') THEN _gcash_reference ELSE NULL END,
      settled_at = now()
  WHERE id = _order_id;
  INSERT INTO public.order_audit_logs(order_id, employee_id, action, before_state, after_state)
  VALUES (
    _order_id, auth.uid(), 'SETTLE',
    jsonb_build_object('settled_at', NULL),
    jsonb_build_object(
      'payment_method', _payment_method, 'cash_received', COALESCE(_cash_received, 0),
      'gcash_amount', COALESCE(_gcash_amount, 0), 'gcash_reference', _gcash_reference,
      'settled_at', now()
    )
  );
END $$;

CREATE OR REPLACE FUNCTION public.complete_order(_order_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  o public.orders;
BEGIN
  IF NOT public.has_any_role(auth.uid(), ARRAY['ADMIN','MANAGER','CASHIER']::public.app_role[]) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  SELECT * INTO o FROM public.orders WHERE id = _order_id FOR UPDATE;
  IF o.id IS NULL OR o.status <> 'READY' OR o.settled_at IS NULL THEN
    RAISE EXCEPTION 'Only settled, ready orders can be completed';
  END IF;
  UPDATE public.orders SET status = 'COMPLETED' WHERE id = _order_id;
  INSERT INTO public.order_audit_logs(order_id, employee_id, action, before_state, after_state)
  VALUES (_order_id, auth.uid(), 'COMPLETE',
    jsonb_build_object('status', o.status), '{"status":"COMPLETED"}'::jsonb);
END $$;

REVOKE EXECUTE ON FUNCTION public.mark_order_items_ready(uuid[], public.station),
  public.modify_order(uuid, jsonb), public.void_order(uuid, text),
  public.settle_order(uuid, text, numeric, numeric, text), public.complete_order(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_order_items_ready(uuid[], public.station),
  public.modify_order(uuid, jsonb), public.void_order(uuid, text),
  public.settle_order(uuid, text, numeric, numeric, text), public.complete_order(uuid) TO authenticated;
