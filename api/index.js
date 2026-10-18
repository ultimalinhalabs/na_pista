// Vercel Function entrypoint: serves the compiled Express app (`npm run build` → dist/src/app.js), the same app
// `npm start` serves. Provisioning is ON DEMAND (2026-10-18, no 24/7 worker): the first request of an organization
// without a credential pulls it (resolver.ts), and a daily Vercel Cron (vercel.json) is the safety net.
import { buildApp } from "../dist/src/app.js";

export default buildApp();
