ALTER TABLE public.orders
  ADD COLUMN table_number text;

CREATE OR REPLACE FUNCTION public.place_order_with_table(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
  table_label text := NULLIF(btrim(payload->>'table_number'), '');
BEGIN
  IF NOT public.has_any_role(auth.uid(), ARRAY['ADMIN','MANAGER','CASHIER']::public.app_role[]) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  IF length(table_label) > 40 THEN
    RAISE EXCEPTION 'Table number must be 40 characters or fewer';
  END IF;

  result := public.place_order(payload);
  UPDATE public.orders
  SET table_number = table_label
  WHERE client_id = (payload->>'client_id')::uuid;

  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_open_order(
  _order_id uuid,
  _items jsonb,
  _discount_type text,
  _customer_name text,
  _order_type public.order_type,
  _table_number text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  o public.orders;
  subtotal numeric;
  new_discount numeric;
  next_discount_type text := NULLIF(_discount_type, '');
  next_customer_name text := NULLIF(btrim(_customer_name), '');
  next_table_number text := NULLIF(btrim(_table_number), '');
BEGIN
  IF NOT public.has_any_role(auth.uid(), ARRAY['ADMIN','MANAGER','CASHIER']::public.app_role[]) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  IF COALESCE(_discount_type, '') NOT IN ('', 'STUDENT', 'SENIOR') THEN
    RAISE EXCEPTION 'Select a valid discount';
  END IF;
  IF length(next_customer_name) > 120 THEN
    RAISE EXCEPTION 'Customer name must be 120 characters or fewer';
  END IF;
  IF length(next_table_number) > 40 THEN
    RAISE EXCEPTION 'Table number must be 40 characters or fewer';
  END IF;

  SELECT * INTO o FROM public.orders WHERE id = _order_id FOR UPDATE;
  IF o.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF o.settled_at IS NOT NULL OR o.status IN ('COMPLETED','CANCELLED') THEN
    RAISE EXCEPTION 'Only unsettled active orders can be modified';
  END IF;

  PERFORM public.modify_order(_order_id, _items);

  SELECT COALESCE(sum(item_price * quantity), 0)
  INTO subtotal
  FROM public.order_items
  WHERE order_id = _order_id AND item_status <> 'CANCELLED';
  IF subtotal <= 0 THEN RAISE EXCEPTION 'Void the entire ticket when no items remain'; END IF;

  new_discount := CASE next_discount_type
    WHEN 'STUDENT' THEN round(subtotal * 0.10, 2)
    WHEN 'SENIOR' THEN round(subtotal * 0.20, 2)
    ELSE 0
  END;

  UPDATE public.orders
  SET customer_name = next_customer_name,
      table_number = next_table_number,
      order_type = _order_type,
      discount_type = next_discount_type,
      discount_amount = new_discount,
      total_amount = subtotal - new_discount
  WHERE id = _order_id;

  IF o.customer_name IS DISTINCT FROM next_customer_name
    OR o.table_number IS DISTINCT FROM next_table_number
    OR o.order_type IS DISTINCT FROM _order_type
    OR o.discount_type IS DISTINCT FROM next_discount_type THEN
    INSERT INTO public.order_audit_logs(order_id, employee_id, action, before_state, after_state)
    VALUES (
      _order_id,
      auth.uid(),
      'MODIFY',
      jsonb_build_object(
        'customer_name', o.customer_name,
        'table_number', o.table_number,
        'order_type', o.order_type,
        'discount_type', o.discount_type,
        'discount_amount', o.discount_amount,
        'total_amount', o.total_amount
      ),
      jsonb_build_object(
        'customer_name', next_customer_name,
        'table_number', next_table_number,
        'order_type', _order_type,
        'discount_type', next_discount_type,
        'discount_amount', new_discount,
        'total_amount', subtotal - new_discount
      )
    );
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.place_order_with_table(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_open_order(uuid, jsonb, text, text, public.order_type, text)
  TO authenticated;

NOTIFY pgrst, 'reload schema';
