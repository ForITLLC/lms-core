import { recordError } from "@/lib/logging";
import { requireApiKey } from "@/lib/api/bearer";
import { withApiLogging } from "@/lib/api/handler";
import { createNotificationDeliveriesHandler } from "@/lib/api/notification-deliveries";
import { authorizeNotificationDeliveryRead, readNotificationDeliveries } from "@/lib/db/notification-deliveries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApiLogging("notification_deliveries", createNotificationDeliveriesHandler({
  authenticate: requireApiKey,
  authorize: authorizeNotificationDeliveryRead,
  read: readNotificationDeliveries,
  recordUnavailable: () => recordError("lms-api", "notification_deliveries: records unavailable", "ERROR"),
}));
