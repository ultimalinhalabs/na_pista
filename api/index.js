// Vercel Function entrypoint: serves the compiled Express app (`npm run build` → dist/src/app.js), the same app
// `npm start` serves. It never starts the D2-B provisioning reconciler — a serverless function has no continuous
// process; the reconciler runs as its own worker on Railway (`npm run start:worker` → dist/src/worker.js).
import { buildApp } from "../dist/src/app.js";

export default buildApp();
