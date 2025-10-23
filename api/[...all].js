import serverless from "serverless-http";
import app from "../bk-server.js";
export default serverless(app);  // no basePath to avoid confusion
