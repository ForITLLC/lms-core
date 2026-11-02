"use client";

import Button from "@/components/Button";

// Save-as-PDF is the share mechanism: the browser print dialog renders the
// certificate (the @media print rules in the page hide everything else) and
// lets the learner pick "Save as PDF" or a real printer.
export default function CertificatePrintButton() {
  return (
    <Button type="button" variant="primary" onClick={() => window.print()}>
      Print / Save as PDF
    </Button>
  );
}
