// Compatibility for the old Monday trigger: both routes share one recipient/day claim.
export { POST } from "@/app/api/cron/daily-digest/route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
