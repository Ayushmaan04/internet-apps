// bk-server.js
import express from "express";
import dotenv from "dotenv";
dotenv.config();

const app = express();

// Log every hit (visible in Vercel → Deployments → Functions → Logs)
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// 1) Health — NOTE the '/api' prefix here
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    environment: process.env.VERCEL ? "vercel" : "local",
    timestamp: new Date().toISOString(),
  });
});

// 2) Catch-all to ensure we always respond (helps debug)
app.use((req, res) => {
  res.status(404).json({ ok: false, path: req.url });
});

// Local only
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Local: http://localhost:${PORT}`));
}

export default app;
