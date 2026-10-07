import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle PostgreSQL client", err);
  process.exit(1);
});

export async function testConnection() {
  const client = await pool.connect();
  try {
    const res = await client.query("SELECT NOW()");
    console.log("✅ Connected to PostgreSQL at:", res.rows[0].now);
  } finally {
    client.release();
  }
}