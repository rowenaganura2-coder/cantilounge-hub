import { executeMysqlQuery } from "./query.functions";
import { executeMysqlRpc } from "./rpc.functions";
import type { Database, Tables } from "./types";

type Operator = "eq" | "neq" | "is" | "gte" | "gt" | "lte" | "lt" | "in" | "not_is";
type Filter = { column: string; operator: Operator; value: unknown };
type QueryError = { message: string; code?: string };
type QueryResult<T> =
  | { data: T; error: null; count: number | null }
  | { data: null; error: QueryError; count: number | null };
type RequestState = {
  table: string;
  operation: "select" | "insert" | "update" | "upsert" | "delete";
  values?: unknown;
  filters: Filter[];
  order: { column: string; ascending: boolean }[];
  offset: number;
  limit: number;
  selection: string;
  count: boolean;
  head: boolean;
};
type TableName = keyof Database["public"]["Tables"];
type FunctionName = keyof Database["public"]["Functions"];
type FunctionArgs<Name extends FunctionName> = Database["public"]["Functions"][Name]["Args"];
type FunctionResult<Name extends FunctionName> = Database["public"]["Functions"][Name]["Returns"];
type RelatedRow = {
  user_roles?: { role: string }[];
  staff_profiles?: { full_name: string; hourly_rate: number } | null;
  categories?: Tables<"categories"> | null;
  recipe_ingredients?: (Tables<"recipe_ingredients"> & {
    ingredients?: Tables<"ingredients"> | null;
  })[];
  ingredients?: Tables<"ingredients"> | null;
};
type RowOf<T> = T extends (infer Row)[] ? Row : T;

class MysqlQuery<T = Record<string, unknown>[]> implements PromiseLike<QueryResult<T>> {
  private readonly state: RequestState;

  constructor(table: string) {
    this.state = {
      table,
      operation: "select",
      filters: [],
      order: [],
      offset: 0,
      limit: 1000,
      selection: "*",
      count: false,
      head: false,
    };
  }

  select(selection = "*", options?: { count?: "exact"; head?: boolean }) {
    this.state.selection = selection;
    this.state.count = options?.count === "exact";
    this.state.head = options?.head ?? false;
    return this;
  }

  insert(values: unknown) {
    this.state.operation = "insert";
    this.state.values = values;
    return this;
  }

  update(values: unknown) {
    this.state.operation = "update";
    this.state.values = values;
    return this;
  }

  upsert(values: unknown, _options?: { onConflict?: string }) {
    this.state.operation = "upsert";
    this.state.values = values;
    return this;
  }

  delete() {
    this.state.operation = "delete";
    return this;
  }

  eq(column: string, value: unknown) {
    return this.filter(column, "eq", value);
  }

  neq(column: string, value: unknown) {
    return this.filter(column, "neq", value);
  }

  is(column: string, value: unknown) {
    return this.filter(column, "is", value);
  }

  not(column: string, operator: string, value: unknown) {
    if (operator !== "is") throw new Error(`Unsupported filter operator: ${operator}`);
    return this.filter(column, "not_is", value);
  }

  gte(column: string, value: unknown) {
    return this.filter(column, "gte", value);
  }

  gt(column: string, value: unknown) {
    return this.filter(column, "gt", value);
  }

  lte(column: string, value: unknown) {
    return this.filter(column, "lte", value);
  }

  lt(column: string, value: unknown) {
    return this.filter(column, "lt", value);
  }

  in(column: string, value: unknown[]) {
    return this.filter(column, "in", value);
  }

  private filter(column: string, operator: Operator, value: unknown) {
    this.state.filters.push({ column, operator, value });
    return this;
  }

  order(column: string, options?: { ascending?: boolean }) {
    this.state.order.push({ column, ascending: options?.ascending ?? true });
    return this;
  }

  limit(limit: number) {
    this.state.limit = limit;
    return this;
  }

  range(from: number, to: number) {
    this.state.offset = from;
    this.state.limit = Math.max(0, to - from + 1);
    return this;
  }

  async maybeSingle(): Promise<QueryResult<(RowOf<T> & RelatedRow) | null>> {
    const response = await this.execute();
    if (response.error) return { data: null, error: response.error, count: response.count };
    const rows = Array.isArray(response.data) ? response.data : [];
    if (rows.length > 1) {
      return { data: null, error: { message: "Expected at most one row." }, count: response.count };
    }
    return { data: (rows[0] as (RowOf<T> & RelatedRow) | undefined) ?? null, error: null, count: response.count };
  }

  async single(): Promise<QueryResult<RowOf<T> & RelatedRow>> {
    const response = await this.execute();
    if (response.error) return { data: null, error: response.error, count: response.count };
    const rows = Array.isArray(response.data) ? response.data : [];
    if (rows.length !== 1) {
      return { data: null, error: { message: "Expected exactly one row." }, count: response.count };
    }
    return { data: rows[0] as RowOf<T> & RelatedRow, error: null, count: response.count };
  }

  private async execute(): Promise<QueryResult<T>> {
    try {
        const response = await executeMysqlQuery({ data: this.state });
        return {
          data: (this.state.head ? [] : response.data) as T,
          error: null,
          count: response.count,
        };
    } catch (error) {
      return {
        data: null,
        error: { message: error instanceof Error ? error.message : String(error) },
        count: null,
      };
    }
  }

  then<TResult1 = QueryResult<T>, TResult2 = never>(
    onfulfilled?: ((value: QueryResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

class MysqlClient {
  from<T extends TableName>(table: T): MysqlQuery<(Tables<T> & RelatedRow)[]> {
    return new MysqlQuery<(Tables<T> & RelatedRow)[]>(table);
  }

  rpc<Name extends FunctionName>(name: Name, args?: FunctionArgs<Name>) {
    return executeMysqlRpc({ data: { name, args: args ?? {} } })
      .then((data) => ({ data: data as FunctionResult<Name>, error: null }))
      .catch((error: unknown) => ({
        data: null,
        error: { message: error instanceof Error ? error.message : String(error) },
      }));
  }
}

export const mysql = new MysqlClient();
