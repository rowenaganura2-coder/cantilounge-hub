import { createFileRoute, redirect } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { TrendingUp } from "lucide-react";
import { mysql } from "@/integrations/mysql/client";
import { peso } from "@/lib/staff-auth";

type Interval = "week" | "month";
type DailyIncome = { day: string; revenue: number; order_count: number };
type IncomePoint = { key: string; label: string; income: number };

export const Route = createFileRoute("/_authenticated/analytics")({
  beforeLoad: ({ context }) => {
    if (!context.staff.roles.includes("ADMIN")) throw redirect({ to: "/pos" });
  },
  head: () => ({
    meta: [
      { title: "Income Analytics — CantiLounge Hub" },
      { name: "description", content: "Weekly and monthly income analytics for Cantilounge." },
    ],
  }),
  component: IncomeAnalyticsPage,
});

function manilaDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const get = (type: "year" | "month" | "day") =>
    Number(parts.find((part) => part.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

function manilaMidnight(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month - 1, day, -8));
}

function dateKey(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: "year" | "month" | "day") =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function IncomeAnalyticsPage() {
  const [interval, setInterval] = useState<Interval>("week");

  const range = useMemo(() => {
    const today = manilaDateParts();
    const currentMonthStart = manilaMidnight(today.year, today.month, 1);
    const currentWeekStart = manilaMidnight(today.year, today.month, today.day);
    const weekday = new Date(
      Date.UTC(today.year, today.month - 1, today.day),
    ).getUTCDay();
    const mondayOffset = (weekday + 6) % 7;
    currentWeekStart.setUTCDate(currentWeekStart.getUTCDate() - mondayOffset);

    const start =
      interval === "week"
        ? new Date(currentWeekStart.getTime() - 11 * 7 * 24 * 60 * 60 * 1000)
        : manilaMidnight(today.year, today.month - 11, 1);
    const end = manilaMidnight(today.year, today.month, today.day + 1);

    return { start: start.toISOString(), end: end.toISOString() };
  }, [interval]);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["income-analytics", interval, range.start, range.end],
    queryFn: async () => {
      const { data, error } = await mysql.rpc("get_income_analytics", {
        _start: range.start,
        _end: range.end,
      });
      if (error) throw error;
      return data as DailyIncome[];
    },
  });

  const chartData = useMemo(() => {
    const daily = new Map((data ?? []).map((row) => [row.day, Number(row.revenue)]));
    const today = manilaDateParts();
    const currentPeriodStart =
      interval === "week"
        ? manilaMidnight(today.year, today.month, today.day)
        : manilaMidnight(today.year, today.month, 1);

    if (interval === "week") {
      const weekday = new Date(
        Date.UTC(today.year, today.month - 1, today.day),
      ).getUTCDay();
      currentPeriodStart.setUTCDate(
        currentPeriodStart.getUTCDate() - ((weekday + 6) % 7),
      );
    }

    return Array.from({ length: 12 }, (_, index): IncomePoint => {
      const offset = index - 11;
      const start = new Date(currentPeriodStart);
      if (interval === "week") start.setUTCDate(start.getUTCDate() + offset * 7);
      else start.setUTCMonth(start.getUTCMonth() + offset);

      const next = new Date(start);
      if (interval === "week") next.setUTCDate(next.getUTCDate() + 7);
      else next.setUTCMonth(next.getUTCMonth() + 1);

      let income = 0;
      for (const [day, amount] of daily) {
        const parsed = new Date(`${day}T00:00:00Z`);
        const keyDate = dateKey(parsed);
        if (keyDate >= dateKey(start) && keyDate < dateKey(next)) income += amount;
      }

      const label =
        interval === "week"
          ? new Intl.DateTimeFormat("en-PH", {
              timeZone: "Asia/Manila",
              month: "short",
              day: "numeric",
            }).format(start)
          : new Intl.DateTimeFormat("en-PH", {
              timeZone: "Asia/Manila",
              month: "short",
              year: "2-digit",
            }).format(start);

      return { key: dateKey(start), label, income };
    });
  }, [data, interval]);

  const average = chartData.length
    ? chartData.reduce((sum, point) => sum + point.income, 0) / chartData.length
    : 0;
  const intervalLabel = interval === "week" ? "week" : "month";

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(212,163,115,0.13),_transparent_36%),#1A120F] p-4 text-[#FAF0E6] sm:p-6 lg:p-8">
      <div className="mx-auto max-w-7xl">
        <header className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.24em] text-[#D4A373]">
              <TrendingUp className="size-4" />
              Admin overview
            </p>
            <h1 className="font-display text-4xl text-[#FAF0E6] sm:text-5xl">Income Analytics</h1>
            <p className="mt-2 text-sm text-[#C8B6A6]">
              Average completed-order income per {interval}, in Philippine pesos.
            </p>
          </div>
          <div className="flex w-fit items-center gap-1 rounded-xl border border-[#4A3831] bg-[#241712]/90 p-1">
            {(["week", "month"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setInterval(value)}
                aria-pressed={interval === value}
                className={`rounded-lg px-4 py-2 text-sm font-semibold capitalize transition ${
                  interval === value
                    ? "bg-[#D4A373] text-[#1A120F]"
                    : "text-[#C8B6A6] hover:text-[#FAF0E6]"
                }`}
              >
                By {value}
              </button>
            ))}
          </div>
        </header>

        {isError && (
          <div
            role="alert"
            className="mb-5 rounded-xl border border-rose-500/30 bg-rose-950/30 p-4 text-sm text-rose-200"
          >
            Unable to load income analytics:{" "}
            {error instanceof Error ? error.message : "Unknown error"}
          </div>
        )}

        <section className="rounded-3xl border border-[#4A3831] bg-[#1D130E]/85 p-4 shadow-[0_24px_60px_rgba(0,0,0,0.2)] backdrop-blur-xl sm:p-6">
          <div className="mb-5 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="font-display text-2xl text-[#FAF0E6]">
                Average income by {interval}
              </h2>
              <p className="mt-1 text-xs text-[#C8B6A6]">
                Last 12 {interval}s · dashed line shows the average
              </p>
            </div>
            {!isLoading && (
              <p className="font-mono text-sm font-semibold text-[#E9B988]">
                Average: {peso(average)} / {interval}
              </p>
            )}
          </div>

          {isLoading ? (
            <div className="grid h-[360px] place-items-center text-sm text-[#C8B6A6]">
              Loading income data…
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={360}>
              <AreaChart data={chartData} margin={{ top: 12, right: 16, bottom: 0, left: 4 }}>
                <defs>
                  <linearGradient id="incomeFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#D4A373" stopOpacity={0.42} />
                    <stop offset="95%" stopColor="#D4A373" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#4A3831" strokeDasharray="4 4" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fill: "#C8B6A6", fontSize: 11 }}
                  axisLine={{ stroke: "#4A3831" }}
                  tickLine={false}
                  minTickGap={18}
                />
                <YAxis
                  tickFormatter={(value: number) => `₱${Number(value).toLocaleString()}`}
                  tick={{ fill: "#C8B6A6", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={86}
                />
                <Tooltip
                  contentStyle={{
                    background: "#1D130E",
                    border: "1px solid #4A3831",
                    borderRadius: 12,
                    color: "#FAF0E6",
                  }}
                  formatter={(value) => [peso(Number(value)), `Income / ${intervalLabel}`]}
                  labelStyle={{ color: "#D4A373" }}
                />
                <ReferenceLine
                  y={average}
                  stroke="#10B981"
                  strokeDasharray="5 5"
                  label={{
                    value: `Avg ${peso(average)}`,
                    fill: "#6EE7B7",
                    fontSize: 11,
                    position: "insideTopRight",
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="income"
                  stroke="#D4A373"
                  strokeWidth={3}
                  fill="url(#incomeFill)"
                  activeDot={{ r: 5, fill: "#E9B988", stroke: "#1A120F", strokeWidth: 2 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </section>
        <p className="mt-4 text-xs text-[#8B7367]">
          Includes completed orders only. Current {interval} may be incomplete.
        </p>
      </div>
    </div>
  );
}
