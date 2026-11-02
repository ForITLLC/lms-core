import { withApiLogging } from "@/lib/api/handler";
import { requireMarketplaceCaller } from "@/lib/api/marketplace/auth";
import { createCatalogueListHandler } from "@/lib/api/marketplace/catalogue";
import { listListableCourses, resolvePublisher } from "@/lib/db/marketplace-catalogue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApiLogging("marketplace_list_courses", createCatalogueListHandler({
  authenticate: (req) => requireMarketplaceCaller(req, "Marketplace.Catalogue.Read"),
  resolvePublisher,
  listCourses: listListableCourses,
}));
