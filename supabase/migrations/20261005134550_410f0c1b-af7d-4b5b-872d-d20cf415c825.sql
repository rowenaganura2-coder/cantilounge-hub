CREATE TYPE public.app_role AS ENUM ('ADMIN','MANAGER','CASHIER','BARISTA','KITCHEN');
CREATE TYPE public.order_status AS ENUM ('PENDING','IN_PREP','READY','COMPLETED','CANCELLED');
CREATE TYPE public.order_type AS ENUM ('DINE_IN','TAKEOUT','ADVANCE');
CREATE TYPE public.station AS ENUM ('BARISTA','KITCHEN');

CREATE TABLE public.staff_profiles (
  id uuid PRIMARY KEY,
  full_name text NOT NULL,
  staff_code text NOT NULL UNIQUE,
  hourly_rate numeric(10,2) NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, UPDATE ON public.staff_profiles TO authenticated;
GRANT ALL ON public.staff_profiles TO service_role;
ALTER TABLE public.staff_profiles ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.staff_profiles(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  UNIQUE (user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles r JOIN public.staff_profiles p ON p.id = r.user_id
                 WHERE r.user_id = _user_id AND r.role = _role AND p.is_active)
$$;
CREATE OR REPLACE FUNCTION public.has_any_role(_user_id uuid, _roles public.app_role[])
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles r JOIN public.staff_profiles p ON p.id = r.user_id
                 WHERE r.user_id = _user_id AND r.role = ANY(_roles) AND p.is_active)
$$;
CREATE OR REPLACE FUNCTION public.is_staff(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.staff_profiles WHERE id = _user_id AND is_active)
$$;
CREATE OR REPLACE FUNCTION public.is_manager(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_any_role(_user_id, ARRAY['ADMIN','MANAGER']::public.app_role[])
$$;

CREATE POLICY "staff read profiles" ON public.staff_profiles FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "managers update profiles" ON public.staff_profiles FOR UPDATE TO authenticated USING (public.is_manager(auth.uid())) WITH CHECK (public.is_manager(auth.uid()));
CREATE POLICY "read own or manager roles" ON public.user_roles FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.is_manager(auth.uid()));

-- Login screen list (names only)
CREATE OR REPLACE FUNCTION public.list_login_staff()
RETURNS TABLE(id uuid, full_name text, staff_code text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, full_name, staff_code FROM public.staff_profiles WHERE is_active ORDER BY full_name
$$;
GRANT EXECUTE ON FUNCTION public.list_login_staff() TO anon, authenticated;

-- ATTENDANCE
CREATE TABLE public.attendance_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.staff_profiles(id) ON DELETE CASCADE,
  clock_in timestamptz NOT NULL DEFAULT now(),
  clock_out timestamptz,
  break_minutes int NOT NULL DEFAULT 0,
  total_hours numeric(5,2),
  is_late boolean NOT NULL DEFAULT false,
  overtime_min int NOT NULL DEFAULT 0,
  notes text
);
CREATE INDEX ON public.attendance_logs(user_id, clock_in DESC);
GRANT SELECT, UPDATE ON public.attendance_logs TO authenticated;
GRANT ALL ON public.attendance_logs TO service_role;
ALTER TABLE public.attendance_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own or manager attendance" ON public.attendance_logs FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.is_manager(auth.uid()));
CREATE POLICY "manager edits attendance" ON public.attendance_logs FOR UPDATE TO authenticated USING (public.is_manager(auth.uid())) WITH CHECK (public.is_manager(auth.uid()));

CREATE OR REPLACE FUNCTION public.clock_in(_late boolean DEFAULT false)
RETURNS public.attendance_logs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.attendance_logs;
BEGIN
  IF NOT public.is_staff(auth.uid()) THEN RAISE EXCEPTION 'Not staff'; END IF;
  IF EXISTS (SELECT 1 FROM attendance_logs WHERE user_id = auth.uid() AND clock_out IS NULL) THEN
    RAISE EXCEPTION 'Already clocked in';
  END IF;
  INSERT INTO attendance_logs(user_id, is_late) VALUES (auth.uid(), _late) RETURNING * INTO r;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.clock_out(_break_minutes int DEFAULT 0)
RETURNS public.attendance_logs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.attendance_logs; mins numeric;
BEGIN
  SELECT * INTO r FROM attendance_logs WHERE user_id = auth.uid() AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Not clocked in'; END IF;
  mins := GREATEST(0, EXTRACT(EPOCH FROM (now() - r.clock_in))/60 - COALESCE(_break_minutes,0));
  UPDATE attendance_logs SET clock_out = now(), break_minutes = COALESCE(_break_minutes,0),
    total_hours = round(mins/60, 2), overtime_min = GREATEST(0, floor(mins - 480))::int
  WHERE id = r.id RETURNING * INTO r;
  RETURN r;
END $$;
GRANT EXECUTE ON FUNCTION public.clock_in(boolean), public.clock_out(int) TO authenticated;

-- INVENTORY & MENU
CREATE TABLE public.ingredients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  unit text NOT NULL,
  cost_per_unit numeric(10,4) NOT NULL DEFAULT 0,
  current_stock numeric(10,2) NOT NULL DEFAULT 0,
  min_threshold numeric(10,2) NOT NULL DEFAULT 0,
  is_available boolean NOT NULL DEFAULT true
);
CREATE TABLE public.categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  sort_order int NOT NULL DEFAULT 0
);
CREATE TABLE public.menu_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  category_id uuid NOT NULL REFERENCES public.categories(id) ON DELETE RESTRICT,
  base_price numeric(10,2) NOT NULL,
  target_station public.station NOT NULL,
  is_available boolean NOT NULL DEFAULT true
);
CREATE INDEX ON public.menu_items(category_id);
CREATE TABLE public.recipe_ingredients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_item_id uuid NOT NULL REFERENCES public.menu_items(id) ON DELETE CASCADE,
  ingredient_id uuid NOT NULL REFERENCES public.ingredients(id) ON DELETE RESTRICT,
  quantity_req numeric(10,2) NOT NULL,
  UNIQUE(menu_item_id, ingredient_id)
);
CREATE TABLE public.stock_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ingredient_id uuid NOT NULL REFERENCES public.ingredients(id) ON DELETE CASCADE,
  change numeric(10,2) NOT NULL,
  reason text NOT NULL,
  order_id uuid,
  user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON public.stock_transactions(ingredient_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ingredients, public.categories, public.menu_items, public.recipe_ingredients TO authenticated;
GRANT SELECT ON public.stock_transactions TO authenticated;
GRANT ALL ON public.ingredients, public.categories, public.menu_items, public.recipe_ingredients, public.stock_transactions TO service_role;
ALTER TABLE public.ingredients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recipe_ingredients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "staff read" ON public.ingredients FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "manager write" ON public.ingredients FOR ALL TO authenticated USING (public.is_manager(auth.uid())) WITH CHECK (public.is_manager(auth.uid()));
CREATE POLICY "staff read" ON public.categories FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "manager write" ON public.categories FOR ALL TO authenticated USING (public.is_manager(auth.uid())) WITH CHECK (public.is_manager(auth.uid()));
CREATE POLICY "staff read" ON public.menu_items FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "manager write" ON public.menu_items FOR ALL TO authenticated USING (public.is_manager(auth.uid())) WITH CHECK (public.is_manager(auth.uid()));
CREATE POLICY "staff read" ON public.recipe_ingredients FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "manager write" ON public.recipe_ingredients FOR ALL TO authenticated USING (public.is_manager(auth.uid())) WITH CHECK (public.is_manager(auth.uid()));
CREATE POLICY "manager read ledger" ON public.stock_transactions FOR SELECT TO authenticated USING (public.is_manager(auth.uid()));

CREATE OR REPLACE FUNCTION public.adjust_stock(_ingredient_id uuid, _change numeric, _reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_manager(auth.uid()) THEN RAISE EXCEPTION 'Forbidden'; END IF;
  UPDATE ingredients SET current_stock = current_stock + _change WHERE id = _ingredient_id;
  INSERT INTO stock_transactions(ingredient_id, change, reason, user_id) VALUES (_ingredient_id, _change, _reason, auth.uid());
END $$;
GRANT EXECUTE ON FUNCTION public.adjust_stock(uuid, numeric, text) TO authenticated;

-- ORDERS
CREATE TABLE public.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL UNIQUE,
  order_number serial,
  order_type public.order_type NOT NULL,
  status public.order_status NOT NULL DEFAULT 'PENDING',
  customer_name text,
  total_amount numeric(10,2) NOT NULL,
  discount_type text,
  discount_amount numeric(10,2) NOT NULL DEFAULT 0,
  cashier_id uuid NOT NULL REFERENCES public.staff_profiles(id),
  created_offline boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON public.orders(status, created_at DESC);
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  menu_item_id uuid NOT NULL REFERENCES public.menu_items(id),
  name text NOT NULL,
  station public.station NOT NULL,
  quantity int NOT NULL CHECK (quantity > 0),
  modifiers jsonb,
  item_price numeric(10,2) NOT NULL,
  item_status public.order_status NOT NULL DEFAULT 'PENDING'
);
CREATE INDEX ON public.order_items(order_id);
CREATE INDEX ON public.order_items(station, item_status);
GRANT SELECT, UPDATE ON public.orders, public.order_items TO authenticated;
GRANT ALL ON public.orders, public.order_items TO service_role;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff read orders" ON public.orders FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "front update orders" ON public.orders FOR UPDATE TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['ADMIN','MANAGER','CASHIER']::public.app_role[]))
  WITH CHECK (public.has_any_role(auth.uid(), ARRAY['ADMIN','MANAGER','CASHIER']::public.app_role[]));
CREATE POLICY "staff read items" ON public.order_items FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "prep update items" ON public.order_items FOR UPDATE TO authenticated
  USING (public.is_staff(auth.uid())) WITH CHECK (public.is_staff(auth.uid()));

-- Roll order status from item statuses
CREATE OR REPLACE FUNCTION public.sync_order_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE total int; ready int; prep int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE item_status IN ('READY','COMPLETED')),
         count(*) FILTER (WHERE item_status = 'IN_PREP')
    INTO total, ready, prep FROM order_items WHERE order_id = NEW.order_id;
  UPDATE orders SET status = CASE WHEN ready = total THEN 'READY'::order_status
                                  WHEN prep > 0 OR ready > 0 THEN 'IN_PREP'::order_status
                                  ELSE 'PENDING'::order_status END
  WHERE id = NEW.order_id AND status NOT IN ('COMPLETED','CANCELLED');
  RETURN NEW;
END $$;
CREATE TRIGGER order_items_sync AFTER UPDATE OF item_status ON public.order_items
FOR EACH ROW EXECUTE FUNCTION public.sync_order_status();

-- Atomic, idempotent order placement with BOM stock deduction
CREATE OR REPLACE FUNCTION public.place_order(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  o public.orders; existing public.orders; it jsonb; mi public.menu_items;
  subtotal numeric := 0; disc numeric := 0; qty int; line_price numeric;
BEGIN
  IF NOT public.has_any_role(auth.uid(), ARRAY['ADMIN','MANAGER','CASHIER']::public.app_role[]) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  SELECT * INTO existing FROM orders WHERE client_id = (payload->>'client_id')::uuid;
  IF existing.id IS NOT NULL THEN
    RETURN jsonb_build_object('id', existing.id, 'order_number', existing.order_number, 'duplicate', true);
  END IF;

  FOR it IN SELECT * FROM jsonb_array_elements(payload->'items') LOOP
    SELECT * INTO mi FROM menu_items WHERE id = (it->>'menu_item_id')::uuid;
    IF mi.id IS NULL THEN RAISE EXCEPTION 'Unknown menu item'; END IF;
    qty := GREATEST(1, (it->>'quantity')::int);
    line_price := mi.base_price + COALESCE((it->>'modifier_price')::numeric, 0);
    subtotal := subtotal + line_price * qty;
  END LOOP;

  disc := CASE payload->>'discount_type'
            WHEN 'STUDENT' THEN round(subtotal * 0.10, 2)
            WHEN 'SENIOR' THEN round(subtotal * 0.20, 2)
            WHEN 'PROMO' THEN LEAST(subtotal, COALESCE((payload->>'promo_amount')::numeric, 0))
            ELSE 0 END;

  INSERT INTO orders(client_id, order_type, customer_name, total_amount, discount_type, discount_amount, cashier_id, created_offline, created_at)
  VALUES ((payload->>'client_id')::uuid, (payload->>'order_type')::order_type, NULLIF(payload->>'customer_name',''),
          subtotal - disc, NULLIF(payload->>'discount_type',''), disc, auth.uid(),
          COALESCE((payload->>'offline')::boolean, false), COALESCE((payload->>'created_at')::timestamptz, now()))
  RETURNING * INTO o;

  FOR it IN SELECT * FROM jsonb_array_elements(payload->'items') LOOP
    SELECT * INTO mi FROM menu_items WHERE id = (it->>'menu_item_id')::uuid;
    qty := GREATEST(1, (it->>'quantity')::int);
    INSERT INTO order_items(order_id, menu_item_id, name, station, quantity, modifiers, item_price)
    VALUES (o.id, mi.id, mi.name, mi.target_station, qty, it->'modifiers', mi.base_price + COALESCE((it->>'modifier_price')::numeric, 0));
    UPDATE ingredients i SET current_stock = i.current_stock - r.quantity_req * qty
      FROM recipe_ingredients r WHERE r.menu_item_id = mi.id AND r.ingredient_id = i.id;
    INSERT INTO stock_transactions(ingredient_id, change, reason, order_id, user_id)
      SELECT r.ingredient_id, -r.quantity_req * qty, 'SALE', o.id, auth.uid() FROM recipe_ingredients r WHERE r.menu_item_id = mi.id;
  END LOOP;

  RETURN jsonb_build_object('id', o.id, 'order_number', o.order_number, 'duplicate', false);
END $$;
GRANT EXECUTE ON FUNCTION public.place_order(jsonb) TO authenticated;

ALTER TABLE public.orders REPLICA IDENTITY FULL;
ALTER TABLE public.order_items REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.orders;
ALTER PUBLICATION supabase_realtime ADD TABLE public.order_items;

-- SEED
INSERT INTO public.categories(name, sort_order) VALUES ('Espresso Bar',1),('Signature',2),('Non-Coffee',3),('Kitchen',4);
INSERT INTO public.ingredients(name, unit, cost_per_unit, current_stock, min_threshold) VALUES
 ('Espresso Beans','g',1.2000,5000,1000),('Fresh Milk','ml',0.0900,20000,4000),('Oat Milk','ml',0.1800,6000,1500),
 ('Matcha Powder','g',3.5000,800,200),('Caramel Syrup','ml',0.4000,2000,400),('Vanilla Syrup','ml',0.4000,2000,400),
 ('Dark Chocolate','g',0.8000,1500,300),('Sourdough Bread','pcs',18.0000,40,10),('Eggs','pcs',9.0000,120,24),
 ('Butter','g',0.6000,2000,400),('Croissant Dough','pcs',22.0000,30,8),('Ham','g',0.9000,1500,300),('Cheese','g',0.8000,1500,300);

WITH c AS (SELECT id, name FROM public.categories)
INSERT INTO public.menu_items(name, category_id, base_price, target_station) VALUES
 ('Espresso',(SELECT id FROM c WHERE name='Espresso Bar'),110,'BARISTA'),
 ('Americano',(SELECT id FROM c WHERE name='Espresso Bar'),130,'BARISTA'),
 ('Cafe Latte',(SELECT id FROM c WHERE name='Espresso Bar'),160,'BARISTA'),
 ('Cappuccino',(SELECT id FROM c WHERE name='Espresso Bar'),160,'BARISTA'),
 ('Spanish Latte',(SELECT id FROM c WHERE name='Signature'),180,'BARISTA'),
 ('Salted Caramel Macchiato',(SELECT id FROM c WHERE name='Signature'),190,'BARISTA'),
 ('Canti Mocha',(SELECT id FROM c WHERE name='Signature'),185,'BARISTA'),
 ('Matcha Latte',(SELECT id FROM c WHERE name='Non-Coffee'),180,'BARISTA'),
 ('Hot Chocolate',(SELECT id FROM c WHERE name='Non-Coffee'),150,'BARISTA'),
 ('Butter Croissant',(SELECT id FROM c WHERE name='Kitchen'),120,'KITCHEN'),
 ('Ham & Cheese Croissant',(SELECT id FROM c WHERE name='Kitchen'),190,'KITCHEN'),
 ('Egg Sourdough Toast',(SELECT id FROM c WHERE name='Kitchen'),210,'KITCHEN');

INSERT INTO public.recipe_ingredients(menu_item_id, ingredient_id, quantity_req)
SELECT m.id, i.id, v.q FROM (VALUES
 ('Espresso','Espresso Beans',18),('Americano','Espresso Beans',18),
 ('Cafe Latte','Espresso Beans',18),('Cafe Latte','Fresh Milk',220),
 ('Cappuccino','Espresso Beans',18),('Cappuccino','Fresh Milk',160),
 ('Spanish Latte','Espresso Beans',18),('Spanish Latte','Fresh Milk',200),('Spanish Latte','Vanilla Syrup',20),
 ('Salted Caramel Macchiato','Espresso Beans',18),('Salted Caramel Macchiato','Fresh Milk',200),('Salted Caramel Macchiato','Caramel Syrup',25),
 ('Canti Mocha','Espresso Beans',18),('Canti Mocha','Fresh Milk',200),('Canti Mocha','Dark Chocolate',25),
 ('Matcha Latte','Matcha Powder',6),('Matcha Latte','Fresh Milk',240),
 ('Hot Chocolate','Dark Chocolate',35),('Hot Chocolate','Fresh Milk',240),
 ('Butter Croissant','Croissant Dough',1),('Butter Croissant','Butter',10),
 ('Ham & Cheese Croissant','Croissant Dough',1),('Ham & Cheese Croissant','Ham',40),('Ham & Cheese Croissant','Cheese',30),
 ('Egg Sourdough Toast','Sourdough Bread',2),('Egg Sourdough Toast','Eggs',2),('Egg Sourdough Toast','Butter',15)
) v(m,i,q) JOIN public.menu_items m ON m.name = v.m JOIN public.ingredients i ON i.name = v.i;