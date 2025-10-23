// zero-dependency serverless function to prove routing works
export default async function handler(req, res) {
  res.status(200).json({
    status: "ok",
    environment: process.env.VERCEL ? "vercel" : "local",
    timestamp: new Date().toISOString()
  });
}