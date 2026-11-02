import Link from "next/link";
import { notFound } from "next/navigation";
import CertificatePrintButton from "@/components/CertificatePrintButton";
import { getCertificateBySerial } from "@/lib/db/certificates";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ serial: string }>;
}

function fmtDate(d: Date | string): string {
  return new Date(d).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

// Public, capability-based: the serial in the URL is an unguessable token, so
// no session check — holding the link is the proof. This is the share/send
// mechanism for a certificate of completion.
export default async function CertificatePage({ params }: PageProps) {
  const { serial } = await params;
  const cert = await getCertificateBySerial(serial);
  if (!cert) notFound();

  const revoked = cert.RevokedAt !== null;
  const expired =
    cert.ExpiresAt !== null && new Date(cert.ExpiresAt).getTime() < Date.now();
  const renewed = cert.RenewedAt !== null;

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-100 to-gray-200 flex flex-col items-center py-10 px-4">
      <style>{`@media print {
        body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        .cert-no-print { display: none !important; }
        .cert-page { background: #fff !important; padding: 0 !important; }
      }`}</style>

      <div className="cert-no-print mb-6 flex items-center gap-4">
        <CertificatePrintButton />
        <Link
          href="/dashboard"
          prefetch={false}
          className="text-sm font-semibold hover:underline"
          style={{ color: "var(--brand-primary)" }}
        >
          ← Back to dashboard
        </Link>
      </div>

      {revoked ? (
        <div className="cert-no-print mb-6 max-w-2xl rounded-md bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-800">
          This certificate has been <strong>revoked</strong> and is no longer valid.
        </div>
      ) : null}
      {!revoked && expired && !renewed ? (
        <div className="cert-no-print mb-6 max-w-2xl rounded-md bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
          This certificate <strong>expired</strong> on {fmtDate(cert.ExpiresAt!)}.
          The course may need to be retaken.
        </div>
      ) : null}
      {!revoked && renewed ? (
        <div className="cert-no-print mb-6 max-w-2xl rounded-md bg-gray-50 border border-gray-200 px-4 py-3 text-sm text-gray-700">
          {expired ? <>This certificate <strong>expired</strong> on {fmtDate(cert.ExpiresAt!)}. </> : null}
          The learner renewed this course; a newer certificate was issued on {fmtDate(cert.RenewedAt!)}.
        </div>
      ) : null}

      <div
        className="relative w-full max-w-3xl bg-white shadow-xl"
        style={{
          border: "10px solid var(--brand-primary)",
          outline: "2px solid var(--brand-primary)",
          outlineOffset: "6px",
        }}
      >
        <div className="px-10 py-12 md:px-16 md:py-16 text-center">
          <p className="text-xs uppercase tracking-[0.35em] text-gray-400">
            {cert.TenantName}
          </p>
          <h1
            className="mt-4 font-serif text-3xl md:text-4xl font-bold"
            style={{ color: "var(--brand-primary)" }}
          >
            Certificate of Completion
          </h1>
          <div
            className="mx-auto mt-3 h-0.5 w-24"
            style={{ backgroundColor: "var(--brand-primary)" }}
          />

          <p className="mt-10 text-sm uppercase tracking-widest text-gray-500">
            This certifies that
          </p>
          <p className="mt-3 font-serif text-3xl md:text-4xl font-semibold text-gray-900">
            {cert.LearnerName}
          </p>

          <p className="mt-8 text-sm uppercase tracking-widest text-gray-500">
            has successfully completed
          </p>
          <p
            className="mt-3 font-serif text-xl md:text-2xl font-semibold"
            style={{ color: "var(--brand-primary)" }}
          >
            {cert.CourseTitle}
          </p>

          <div className="mt-12 flex items-end justify-between gap-6">
            <div className="text-left">
              <p className="text-sm font-semibold text-gray-800">
                {fmtDate(cert.IssuedAt)}
              </p>
              <div className="mt-1 w-40 border-t border-gray-300" />
              <p className="text-xs text-gray-500 mt-1">Date issued</p>
            </div>

            <div
              className="flex h-24 w-24 shrink-0 flex-col items-center justify-center rounded-full text-white"
              style={{ backgroundColor: "var(--brand-primary)" }}
            >
              <span className="text-2xl leading-none">✓</span>
              <span className="mt-1 text-[9px] font-bold uppercase tracking-widest">
                Verified
              </span>
            </div>

            <div className="text-right">
              <p className="text-sm font-semibold text-gray-800">
                {cert.TenantName}
              </p>
              <div className="mt-1 w-40 border-t border-gray-300 ml-auto" />
              <p className="text-xs text-gray-500 mt-1">Issuing organization</p>
            </div>
          </div>

          <p className="mt-10 text-[11px] text-gray-400">
            Certificate serial{" "}
            <span className="font-mono">{cert.SerialNo}</span>
            {cert.ExpiresAt
              ? ` · valid until ${fmtDate(cert.ExpiresAt)}`
              : " · does not expire"}
          </p>
        </div>
      </div>

      <p className="cert-no-print mt-6 text-xs text-gray-500">
        Verify this certificate by its serial number with {cert.TenantName}.
      </p>
    </div>
  );
}
