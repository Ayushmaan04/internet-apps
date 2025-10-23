import express from "express";
import dotenv from "dotenv";
dotenv.config();

const app = express();

// log incoming requests to Vercel Function logs
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// IMPORTANT: when using the wrapper above (no basePath),
// define routes WITH the /api prefix
app.get("/api/health-express", (req, res) => {
  res.json({
    status: "ok (express)",
    environment: process.env.VERCEL ? "vercel" : "local",
    timestamp: new Date().toISOString()
  });
});

// last-resort 404 so we ALWAYS reply (prevents hanging)
app.use((req, res) => {
  res.status(404).json({ ok: false, path: req.url });
});

if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Local: http://localhost:${PORT}`));
}

export default app;
