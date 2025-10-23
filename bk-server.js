// bk-server.js
import express from "express";
import dotenv from "dotenv";
dotenv.config();

const app = express();

// (Optional) tiny log so you can see hits in Vercel "Functions → Logs"
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ---- Health (no /api prefix here) ----
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    environment: process.env.VERCEL ? "vercel" : "local",
    timestamp: new Date().toISOString(),
  });
});

// Local only
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Local: http://localhost:${PORT}`));
}

export default app;
