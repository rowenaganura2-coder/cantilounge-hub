REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role), public.has_any_role(uuid, public.app_role[]), public.is_staff(uuid), public.is_manager(uuid),
  public.clock_in(boolean), public.clock_out(int), public.adjust_stock(uuid, numeric, text), public.place_order(jsonb), public.sync_order_status() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.sync_order_status() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role), public.has_any_role(uuid, public.app_role[]), public.is_staff(uuid), public.is_manager(uuid),
  public.clock_in(boolean), public.clock_out(int), public.adjust_stock(uuid, numeric, text), public.place_order(jsonb) TO authenticated;