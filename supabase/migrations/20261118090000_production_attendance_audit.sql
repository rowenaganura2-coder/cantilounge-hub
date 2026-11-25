CREATE TABLE public.staff_face_descriptors (
  user_id uuid PRIMARY KEY REFERENCES public.staff_profiles(id) ON DELETE CASCADE,
  descriptor jsonb NOT NULL,
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_face_descriptors_shape CHECK (
    CASE
      WHEN jsonb_typeof(descriptor) = 'array'
        THEN jsonb_array_length(descriptor) = 128
      ELSE false
    END
  )
);
ALTER TABLE public.staff_face_descriptors ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.staff_face_descriptors TO service_role;

ALTER TABLE public.attendance_logs
  ADD COLUMN verification_method text NOT NULL DEFAULT 'MANUAL'
    CHECK (verification_method IN ('MANUAL', 'FACE_ID', 'PIN_OVERRIDE'));
ALTER TABLE public.attendance_logs
  ADD COLUMN override_by uuid REFERENCES public.staff_profiles(id) ON DELETE SET NULL;

ALTER TABLE public.ingredients
  ADD COLUMN reorder_level numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN expires_at date,
  ADD COLUMN low_stock_notified_at timestamptz;

UPDATE public.ingredients
SET reorder_level = min_threshold
WHERE reorder_level = 0;

CREATE OR REPLACE FUNCTION public.reset_ingredient_alert_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.current_stock > NEW.reorder_level
    AND NEW.is_available
    AND (NEW.expires_at IS NULL OR NEW.expires_at > CURRENT_DATE + 7) THEN
    NEW.low_stock_notified_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reset_ingredient_alert_state
  BEFORE UPDATE OF current_stock, reorder_level, is_available, expires_at ON public.ingredients
  FOR EACH ROW EXECUTE FUNCTION public.reset_ingredient_alert_state();

CREATE TABLE public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES public.staff_profiles(id) ON DELETE SET NULL,
  actor_role text NOT NULL DEFAULT 'SYSTEM',
  action_type text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  entity_label text,
  old_value jsonb,
  new_value jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_at_idx ON public.audit_logs(created_at DESC);
CREATE INDEX audit_logs_entity_idx ON public.audit_logs(entity_type, entity_id, created_at DESC);
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.audit_logs TO authenticated;
GRANT ALL ON public.audit_logs TO service_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.audit_logs FROM anon, authenticated;
CREATE POLICY "admins read audit logs" ON public.audit_logs
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'ADMIN'::public.app_role));

CREATE OR REPLACE FUNCTION public.prevent_audit_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'Audit logs are immutable';
END;
$$;
CREATE TRIGGER audit_logs_immutable
  BEFORE UPDATE OR DELETE ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.prevent_audit_log_mutation();
CREATE TRIGGER order_audit_logs_immutable
  BEFORE UPDATE OR DELETE ON public.order_audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.prevent_audit_log_mutation();

CREATE OR REPLACE FUNCTION public.audit_menu_item_changes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  action_name text;
  actor_role_name text;
  target_id text;
  old_data jsonb;
  new_data jsonb;
BEGIN
  IF current_setting('cantilounge.skip_audit', true) = 'true' THEN RETURN NULL; END IF;
  target_id := COALESCE(NEW.id, OLD.id)::text;
  old_data := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  new_data := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  action_name := CASE
    WHEN TG_OP = 'DELETE' THEN 'MENU_ITEM_DELETED'
    WHEN TG_OP = 'INSERT' THEN 'MENU_ITEM_CREATED'
    WHEN OLD.base_price IS DISTINCT FROM NEW.base_price THEN 'MENU_PRICE_UPDATED'
    WHEN OLD.image_url IS DISTINCT FROM NEW.image_url THEN 'MENU_PHOTO_UPDATED'
    ELSE 'MENU_ITEM_UPDATED'
  END;
  SELECT role::text INTO actor_role_name
  FROM public.user_roles WHERE user_id = auth.uid()
  ORDER BY CASE role::text WHEN 'ADMIN' THEN 0 ELSE 1 END LIMIT 1;
  INSERT INTO public.audit_logs(
    actor_user_id, actor_role, action_type, entity_type, entity_id, entity_label, old_value, new_value
  )
  VALUES (
    auth.uid(), COALESCE(actor_role_name, 'SYSTEM'), action_name, 'MENU_ITEM', target_id,
    COALESCE(NEW.name, OLD.name), old_data, new_data
  );
  RETURN NULL;
END;
$$;
CREATE TRIGGER audit_menu_item_changes
  AFTER INSERT OR UPDATE OR DELETE ON public.menu_items
  FOR EACH ROW EXECUTE FUNCTION public.audit_menu_item_changes();

CREATE OR REPLACE FUNCTION public.audit_stock_transactions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ingredient_name text;
  stock_after numeric;
  actor_role_name text;
  action_name text;
BEGIN
  IF current_setting('cantilounge.skip_audit', true) = 'true' THEN RETURN NULL; END IF;
  SELECT name, current_stock INTO ingredient_name, stock_after
  FROM public.ingredients WHERE id = NEW.ingredient_id;
  SELECT role::text INTO actor_role_name
  FROM public.user_roles WHERE user_id = NEW.user_id
  ORDER BY CASE role::text WHEN 'ADMIN' THEN 0 ELSE 1 END LIMIT 1;
  action_name := CASE
    WHEN upper(NEW.reason) LIKE '%WASTE%' THEN 'WASTE_LOGGED'
    WHEN NEW.order_id IS NULL THEN 'STOCK_ADJUSTED'
    ELSE 'STOCK_DEDUCTED'
  END;
  INSERT INTO public.audit_logs(
    actor_user_id, actor_role, action_type, entity_type, entity_id, entity_label, old_value, new_value
  )
  VALUES (
    NEW.user_id, COALESCE(actor_role_name, 'SYSTEM'), action_name, 'INGREDIENT',
    NEW.ingredient_id::text, ingredient_name,
    jsonb_build_object('current_stock', stock_after - NEW.change),
    jsonb_build_object(
      'current_stock', stock_after, 'change', NEW.change,
      'reason', NEW.reason, 'order_id', NEW.order_id
    )
  );
  RETURN NULL;
END;
$$;
CREATE TRIGGER audit_stock_transactions
  AFTER INSERT ON public.stock_transactions
  FOR EACH ROW EXECUTE FUNCTION public.audit_stock_transactions();

CREATE OR REPLACE FUNCTION public.audit_order_events()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  order_label text;
  actor_role_name text;
BEGIN
  IF current_setting('cantilounge.skip_audit', true) = 'true' THEN RETURN NULL; END IF;
  SELECT 'Order #' || order_number INTO order_label
  FROM public.orders WHERE id = NEW.order_id;
  SELECT role::text INTO actor_role_name
  FROM public.user_roles WHERE user_id = NEW.employee_id
  ORDER BY CASE role::text WHEN 'ADMIN' THEN 0 ELSE 1 END LIMIT 1;
  INSERT INTO public.audit_logs(
    actor_user_id, actor_role, action_type, entity_type, entity_id, entity_label,
    old_value, new_value
  )
  VALUES (
    NEW.employee_id, COALESCE(actor_role_name, 'SYSTEM'), 'ORDER_' || NEW.action,
    'ORDER', NEW.order_id::text, order_label,
    jsonb_build_object('state', NEW.before_state),
    jsonb_build_object('state', NEW.after_state, 'reason', NEW.reason)
  );
  RETURN NULL;
END;
$$;
CREATE TRIGGER audit_order_events
  AFTER INSERT ON public.order_audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.audit_order_events();

CREATE OR REPLACE FUNCTION public.audit_attendance_events()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor_role_name text;
  action_name text;
BEGIN
  IF current_setting('cantilounge.skip_audit', true) = 'true' THEN RETURN NULL; END IF;
  IF NEW.verification_method = 'PIN_OVERRIDE' AND NEW.override_by IS NOT NULL THEN
    SELECT role::text INTO actor_role_name
    FROM public.user_roles WHERE user_id = NEW.override_by
    ORDER BY CASE role::text WHEN 'ADMIN' THEN 0 ELSE 1 END LIMIT 1;
  ELSE
    SELECT role::text INTO actor_role_name
    FROM public.user_roles WHERE user_id = NEW.user_id
    ORDER BY CASE role::text WHEN 'ADMIN' THEN 0 ELSE 1 END LIMIT 1;
  END IF;
  action_name := CASE
    WHEN NEW.verification_method = 'PIN_OVERRIDE' THEN 'STAFF_CLOCK_OVERRIDE'
    WHEN TG_OP = 'INSERT' THEN 'STAFF_CLOCK_IN'
    ELSE 'STAFF_CLOCK_OUT'
  END;
  INSERT INTO public.audit_logs(
    actor_user_id, actor_role, action_type, entity_type, entity_id, entity_label, new_value
  )
  SELECT
    COALESCE(NEW.override_by, NEW.user_id), COALESCE(actor_role_name, 'SYSTEM'),
    action_name, 'ATTENDANCE',
    NEW.id::text, p.full_name,
    jsonb_build_object(
      'clock_in', NEW.clock_in, 'clock_out', NEW.clock_out,
      'verification_method', NEW.verification_method
    )
  FROM public.staff_profiles p WHERE p.id = NEW.user_id;
  RETURN NULL;
END;
$$;
CREATE TRIGGER audit_attendance_events
  AFTER INSERT OR UPDATE OF clock_out ON public.attendance_logs
  FOR EACH ROW EXECUTE FUNCTION public.audit_attendance_events();

CREATE OR REPLACE FUNCTION public.record_verified_attendance(
  _user_id uuid,
  _action text,
  _break_minutes integer,
  _verification_method text,
  _override_by uuid DEFAULT NULL
)
RETURNS public.attendance_logs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  shift public.attendance_logs;
  logged_at timestamptz := now();
  worked_minutes integer;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  IF _action NOT IN ('CLOCK_IN', 'CLOCK_OUT')
    OR _verification_method NOT IN ('FACE_ID', 'PIN_OVERRIDE')
    OR COALESCE(_break_minutes, 0) < 0 OR COALESCE(_break_minutes, 0) > 240 THEN
    RAISE EXCEPTION 'Invalid attendance action';
  END IF;
  IF _verification_method = 'PIN_OVERRIDE'
    AND (_override_by IS NULL OR NOT public.has_role(_override_by, 'ADMIN'::public.app_role)) THEN
    RAISE EXCEPTION 'Only an active admin can authorize a PIN override';
  END IF;

  PERFORM 1 FROM public.staff_profiles
  WHERE id = _user_id AND is_active
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Staff member is not active'; END IF;

  SELECT * INTO shift
  FROM public.attendance_logs
  WHERE user_id = _user_id AND clock_out IS NULL
  ORDER BY clock_in DESC
  LIMIT 1
  FOR UPDATE;

  IF _action = 'CLOCK_IN' THEN
    IF shift.id IS NOT NULL THEN RAISE EXCEPTION 'Already clocked in'; END IF;
    INSERT INTO public.attendance_logs(user_id, verification_method, override_by)
    VALUES (_user_id, _verification_method, _override_by)
    RETURNING * INTO shift;
    RETURN shift;
  END IF;

  IF shift.id IS NULL THEN RAISE EXCEPTION 'Not clocked in'; END IF;
  worked_minutes := GREATEST(
    0,
    FLOOR(EXTRACT(EPOCH FROM (logged_at - shift.clock_in)) / 60)::integer
      - COALESCE(_break_minutes, 0)
  );
  UPDATE public.attendance_logs
  SET clock_out = logged_at,
      break_minutes = COALESCE(_break_minutes, 0),
      total_hours = ROUND(worked_minutes::numeric / 60, 2),
      overtime_min = GREATEST(0, worked_minutes - 480),
      verification_method = _verification_method,
      override_by = _override_by
  WHERE id = shift.id
  RETURNING * INTO shift;
  RETURN shift;
END;
$$;
REVOKE ALL ON FUNCTION public.record_verified_attendance(uuid, text, integer, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_verified_attendance(uuid, text, integer, text, uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.restore_business_backup(_backup jsonb, _actor_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  IF NOT public.has_role(_actor_user_id, 'ADMIN'::public.app_role) THEN
    RAISE EXCEPTION 'Only an active admin can restore a backup';
  END IF;
  IF jsonb_typeof(_backup->'tables') <> 'object' THEN
    RAISE EXCEPTION 'Invalid backup tables';
  END IF;
  PERFORM set_config('cantilounge.skip_audit', 'true', true);

  INSERT INTO public.staff_profiles
  SELECT * FROM jsonb_populate_recordset(NULL::public.staff_profiles, _backup->'tables'->'staff_profiles')
  ON CONFLICT (id) DO UPDATE SET
    full_name = EXCLUDED.full_name, staff_code = EXCLUDED.staff_code,
    hourly_rate = EXCLUDED.hourly_rate, is_active = EXCLUDED.is_active,
    created_at = EXCLUDED.created_at;
  INSERT INTO public.user_roles
  SELECT * FROM jsonb_populate_recordset(NULL::public.user_roles, _backup->'tables'->'user_roles')
  ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, role = EXCLUDED.role;
  INSERT INTO public.categories
  SELECT * FROM jsonb_populate_recordset(NULL::public.categories, _backup->'tables'->'categories')
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order;
  INSERT INTO public.ingredients
  SELECT * FROM jsonb_populate_recordset(NULL::public.ingredients, _backup->'tables'->'ingredients')
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name, unit = EXCLUDED.unit, cost_per_unit = EXCLUDED.cost_per_unit,
    current_stock = EXCLUDED.current_stock, min_threshold = EXCLUDED.min_threshold,
    reorder_level = EXCLUDED.reorder_level, expires_at = EXCLUDED.expires_at,
    is_available = EXCLUDED.is_available, low_stock_notified_at = EXCLUDED.low_stock_notified_at;
  INSERT INTO public.menu_items
  SELECT * FROM jsonb_populate_recordset(NULL::public.menu_items, _backup->'tables'->'menu_items')
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name, category_id = EXCLUDED.category_id,
    base_price = EXCLUDED.base_price, target_station = EXCLUDED.target_station,
    is_available = EXCLUDED.is_available, is_active = EXCLUDED.is_active,
    image_url = EXCLUDED.image_url;
  INSERT INTO public.recipe_ingredients
  SELECT * FROM jsonb_populate_recordset(NULL::public.recipe_ingredients, _backup->'tables'->'recipe_ingredients')
  ON CONFLICT (id) DO UPDATE SET
    menu_item_id = EXCLUDED.menu_item_id, ingredient_id = EXCLUDED.ingredient_id,
    quantity_req = EXCLUDED.quantity_req;
  INSERT INTO public.orders
  SELECT * FROM jsonb_populate_recordset(NULL::public.orders, _backup->'tables'->'orders')
  ON CONFLICT (id) DO UPDATE SET
    client_id = EXCLUDED.client_id, order_number = EXCLUDED.order_number,
    order_type = EXCLUDED.order_type, status = EXCLUDED.status,
    customer_name = EXCLUDED.customer_name, table_number = EXCLUDED.table_number,
    total_amount = EXCLUDED.total_amount, discount_type = EXCLUDED.discount_type,
    discount_amount = EXCLUDED.discount_amount, cashier_id = EXCLUDED.cashier_id,
    created_offline = EXCLUDED.created_offline, payment_method = EXCLUDED.payment_method,
    cash_received = EXCLUDED.cash_received, gcash_amount = EXCLUDED.gcash_amount,
    gcash_reference = EXCLUDED.gcash_reference, payment_reference = EXCLUDED.payment_reference,
    settled_at = EXCLUDED.settled_at, created_at = EXCLUDED.created_at;
  INSERT INTO public.order_items
  SELECT * FROM jsonb_populate_recordset(NULL::public.order_items, _backup->'tables'->'order_items')
  ON CONFLICT (id) DO UPDATE SET
    order_id = EXCLUDED.order_id, menu_item_id = EXCLUDED.menu_item_id,
    name = EXCLUDED.name, station = EXCLUDED.station, quantity = EXCLUDED.quantity,
    modifiers = EXCLUDED.modifiers, item_price = EXCLUDED.item_price,
    item_status = EXCLUDED.item_status;
  INSERT INTO public.stock_transactions
  SELECT * FROM jsonb_populate_recordset(NULL::public.stock_transactions, _backup->'tables'->'stock_transactions')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.attendance_logs
  SELECT * FROM jsonb_populate_recordset(NULL::public.attendance_logs, _backup->'tables'->'attendance_logs')
  ON CONFLICT (id) DO UPDATE SET
    user_id = EXCLUDED.user_id, clock_in = EXCLUDED.clock_in,
    clock_out = EXCLUDED.clock_out, break_minutes = EXCLUDED.break_minutes,
    total_hours = EXCLUDED.total_hours, is_late = EXCLUDED.is_late,
    overtime_min = EXCLUDED.overtime_min, notes = EXCLUDED.notes,
    verification_method = EXCLUDED.verification_method, override_by = EXCLUDED.override_by;
  INSERT INTO public.staff_face_descriptors
  SELECT * FROM jsonb_populate_recordset(NULL::public.staff_face_descriptors, _backup->'tables'->'staff_face_descriptors')
  ON CONFLICT (user_id) DO UPDATE SET
    descriptor = EXCLUDED.descriptor, enrolled_at = EXCLUDED.enrolled_at;
  INSERT INTO public.order_audit_logs
  SELECT * FROM jsonb_populate_recordset(NULL::public.order_audit_logs, _backup->'tables'->'order_audit_logs')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.audit_logs
  SELECT * FROM jsonb_populate_recordset(NULL::public.audit_logs, _backup->'tables'->'audit_logs')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.audit_logs(
    actor_user_id, actor_role, action_type, entity_type, entity_label, new_value
  )
  VALUES (
    _actor_user_id, 'ADMIN', 'DATABASE_RESTORED', 'DATABASE', 'Application data',
    jsonb_build_object('source_version', _backup->>'version')
  );
  IF EXISTS (SELECT 1 FROM public.orders) THEN
    PERFORM setval(
      pg_get_serial_sequence('public.orders', 'order_number'),
      (SELECT max(order_number) FROM public.orders),
      true
    );
  ELSE
    PERFORM setval(pg_get_serial_sequence('public.orders', 'order_number'), 1, false);
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.restore_business_backup(jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restore_business_backup(jsonb, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
