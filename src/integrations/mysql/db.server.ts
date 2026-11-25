import {
  createPool,
  type Pool,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
  type ExecuteValues,
} from "mysql2/promise";

export function sqlValue(value: unknown): ExecuteValues {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean" ||
    value instanceof Date ||
    Buffer.isBuffer(value) ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  if (value === undefined) return null;
  return JSON.stringify(value);
}

let pool: Pool | undefined;

export function getPool() {
  if (pool) return pool;
  const uri =
    process.env["DATABASE_URL"] ??
    (process.env["NODE_ENV"] === "production"
      ? undefined
      : "mysql://root@127.0.0.1:3306/cantilounge_hub");
  if (!uri) {
    throw new Error(
      "DATABASE_URL is required in production. For local XAMPP, start MySQL and import cantilounge_xampp.sql.",
    );
  }
  const parsed = new URL(uri);
  if (!["mysql:", "mariadb:"].includes(parsed.protocol)) {
    throw new Error("DATABASE_URL must use the mysql:// or mariadb:// scheme.");
  }
  pool = createPool({
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.replace(/^\/+/, "")),
    connectionLimit: Number(process.env["DB_POOL_SIZE"] || 10),
    waitForConnections: true,
    queueLimit: 0,
    timezone: "Z",
    decimalNumbers: true,
    dateStrings: false,
    charset: "utf8mb4",
  });
  return pool;
}

export async function queryRows<T extends RowDataPacket>(
  sql: string,
  values: readonly ExecuteValues[] = [],
) {
  const [rows] = await getPool().execute<T[]>(sql, [...values]);
  return rows;
}

export async function execute(
  sql: string,
  values: readonly ExecuteValues[] = [],
): Promise<ResultSetHeader> {
  const [result] = await getPool().execute<ResultSetHeader>(sql, [...values]);
  return result;
}

export async function withTransaction<T>(work: (connection: PoolConnection) => Promise<T>) {
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export const identifier = (name: string) => `\`${name.replace(/`/g, "``")}\``;
