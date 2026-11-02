// The iPhone app posts here with its lmk_ device key. The handler is the web
// learner route's own: getSessionUser() accepts the key, so grading, progress
// and certificates follow exactly the rules the web player does.
export { POST } from "@/app/api/learner/progress/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
