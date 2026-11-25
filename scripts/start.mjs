if (!process.env.PORT) process.env.PORT = "8080";

await import("../.output/server/index.mjs");
