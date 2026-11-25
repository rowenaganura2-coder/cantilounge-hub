CREATE OR REPLACE FUNCTION public.get_income_analytics(
  _start timestamptz,
  _end timestamptz
)
RETURNS TABLE(day date, revenue numeric, order_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'ADMIN'::public.app_role) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  IF _start IS NULL OR _end IS NULL OR _start >= _end THEN
    RAISE EXCEPTION 'Invalid analytics date range';
  END IF;

  RETURN QUERY
  SELECT
    (o.created_at AT TIME ZONE 'Asia/Manila')::date AS day,
    COALESCE(SUM(o.total_amount), 0)::numeric AS revenue,
    COUNT(*)::bigint AS order_count
  FROM public.orders o
  WHERE o.status = 'COMPLETED'::public.order_status
    AND o.created_at >= _start
    AND o.created_at < _end
  GROUP BY (o.created_at AT TIME ZONE 'Asia/Manila')::date
  ORDER BY (o.created_at AT TIME ZONE 'Asia/Manila')::date;
END;
$$;

REVOKE ALL ON FUNCTION public.get_income_analytics(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_income_analytics(timestamptz, timestamptz) TO authenticated;
