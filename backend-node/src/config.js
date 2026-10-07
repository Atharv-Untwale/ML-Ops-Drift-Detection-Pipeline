import dotenv from "dotenv";
dotenv.config();

export const config = {
  port: process.env.PORT || 4000,
  databaseUrl: process.env.DATABASE_URL,
  mlServiceUrl: process.env.ML_SERVICE_URL || "http://localhost:8000",
};

if (!config.databaseUrl) {
  throw new Error("DATABASE_URL is not set. Check your .env file.");
}