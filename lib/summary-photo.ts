import type { InlineImageAttachment } from "@/lib/vendor/email";
import { queryOne } from "@/lib/db";
import { getUserPhoto } from "@/lib/graph";

export const SUMMARY_PHOTO_CID = "learning-recipient-portrait";
const MAX_BYTES = 100 * 1024;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only the tenant's known recipient identity can choose a directory object. */
export async function getSummaryRecipientPhoto(tenantId: string, recipientEmail: string): Promise<InlineImageAttachment | null> {
  try {
    const recipient = await queryOne<{ AzureOid: string | null }>(`SELECT TOP 1 AzureOid FROM (
      SELECT l.AzureOid, 0 AS Priority FROM lms.Learner l
      JOIN lms.Tenant tenant ON tenant.TenantId = l.TenantId AND tenant.TenantId = @tenantId
      WHERE l.TenantId = @tenantId AND LOWER(l.Email) = @email AND l.Status = 'active'
      UNION ALL
      SELECT u.AzureOid, 1 AS Priority FROM lms.AppUser u
      JOIN lms.Tenant tenant ON tenant.TenantId = u.TenantId AND tenant.TenantId = @tenantId
      WHERE u.TenantId = @tenantId AND LOWER(u.Email) = @email
    ) recipient WHERE AzureOid IS NOT NULL ORDER BY Priority`, { tenantId, email: recipientEmail.trim().toLowerCase() });
    if (!recipient?.AzureOid || !GUID.test(recipient.AzureOid)) return null;
    const photo = await getUserPhoto(recipient.AzureOid);
    if (!photo || !photo.bytes.byteLength || photo.bytes.byteLength > MAX_BYTES) return null;
    const bytes = Buffer.from(photo.bytes);
    const contentType = photo.contentType.split(";")[0]?.trim().toLowerCase();
    const png = contentType === "image/png" && bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = contentType === "image/jpeg" && bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217;
    if (!png && !jpeg) return null;
    return { contentId: SUMMARY_PHOTO_CID, contentBytes: bytes.toString("base64"), contentType: png ? "image/png" : "image/jpeg",
      name: png ? "recipient.png" : "recipient.jpg", isInline: true };
  } catch {
    // Optional directory decoration never prevents the actual learning summary.
    return null;
  }
}
