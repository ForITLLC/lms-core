import { withApiLogging } from "@/lib/api/handler";
import { requireMarketplaceCaller } from "@/lib/api/marketplace/auth";
import { createCatalogueCourseHandler } from "@/lib/api/marketplace/catalogue";
import { findCoursePublisher, getListableCourse } from "@/lib/db/marketplace-catalogue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApiLogging("marketplace_get_course", createCatalogueCourseHandler({
  authenticate: (req) => requireMarketplaceCaller(req, "Marketplace.Catalogue.Read"),
  findCoursePublisher,
  getCourse: getListableCourse,
}));
