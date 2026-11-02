import { renderBranded, renderBrandedText, type BrandedEmailOptions, type BrandedFooter, type BrandIdentity, type BrandedDocument, type BrandingOverride,
  type InlineImageAttachment, type RenderedBrandedEmail, type RenderedBrandedText } from "@/lib/vendor/email";
import { foritEmailLockup, isForitTenant } from "@/lib/forit-brand";

function sectionIcon(value: string): string {
  return value.replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (entity, number: string) => {
    const point = number.toLowerCase().startsWith("x") ? parseInt(number.slice(1), 16) : parseInt(number, 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point) : entity;
  });
}

type DigestTenant = { slug?: string; name: string; branding: BrandingOverride; logoDataUri: string | null };
type DigestContent = Omit<BrandedEmailOptions, "branding"> & { footer?: BrandedFooter };

function digestMessage(tenant: DigestTenant, content: DigestContent, attachments: InlineImageAttachment[]): { brand: BrandIdentity; document: BrandedDocument } {
  const { branding } = tenant;
  return {
    brand: {
      tenant_id: tenant.slug ?? tenant.name,
      company_name: tenant.name,
      primary_color: branding.primaryColor ?? "",
      secondary_color: branding.secondaryColor ?? "",
      accent_color: branding.accentColor ?? "",
      ...(isForitTenant(tenant.slug)
        ? { logo_white_url: foritEmailLockup() }
        : { logo_url: tenant.logoDataUri ?? undefined }),
      support_email: branding.supportEmail,
    },
    document: {
      title: content.title,
      subtitle: content.subtitle,
      preheader: content.preheader,
      blocks: content.sections.map(section => ({
        kind: "section",
        label: section.title,
        icon: sectionIcon(section.emoji),
        blocks: [{ kind: "note", html: section.content }],
      })),
      footerNote: [content.footerText, content.footerSubtext].filter(Boolean).join(" · "),
      ...(content.footer ? { footer: content.footer } : {}),
      attachments,
    },
  };
}

/** Keep the tenant's byte source and the rendered CID parts in one value. */
export function renderLearningDigest(tenant: DigestTenant, content: DigestContent, attachments: InlineImageAttachment[] = []): RenderedBrandedEmail {
  const { brand, document } = digestMessage(tenant, content, attachments);
  return renderBranded(brand, document);
}

/** The same message as the HTML, for the text part; `unsubscribe` is the footer's link, for the headers. */
export function renderLearningDigestText(tenant: DigestTenant, content: DigestContent, attachments: InlineImageAttachment[] = []): RenderedBrandedText {
  const { brand, document } = digestMessage(tenant, content, attachments);
  return renderBrandedText(brand, document);
}
