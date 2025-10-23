// api/[...all].js
import serverless from "serverless-http";
import app from "../bk-server.js";

// This makes all /api/* requests go to your Express app,
// and strips the /api prefix before Express sees the path.
export default serverless(app, { basePath: "/api" });
