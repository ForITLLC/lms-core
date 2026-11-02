import { recordError } from "@/lib/logging";
import { requireApiKey } from "@/lib/api/bearer";
import { withApiLogging } from "@/lib/api/handler";
import { createLearningSummaryFeedHandler } from "@/lib/api/learning-summary-feed";
import { readLearningSummaryFeed } from "@/lib/db/learning-summary-feed";
import { authorizeNotificationDeliveryRead } from "@/lib/db/notification-deliveries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApiLogging("learning_summary", createLearningSummaryFeedHandler({
  authenticate: (req) => requireApiKey(req, { allowOwnerOnly: true }),
  authorize: authorizeNotificationDeliveryRead,
  read: readLearningSummaryFeed,
  recordUnavailable: () => recordError("lms-api", "learning_summary: summary unavailable", "ERROR"),
}));
