ALTER TABLE public.menu_items
  ADD COLUMN is_active boolean NOT NULL DEFAULT true;

NOTIFY pgrst, 'reload schema';
