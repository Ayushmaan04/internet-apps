import serverless from "serverless-http";
import app from "../bk-server.js";   // <-- your express app
export default serverless(app);