import { Banner } from "./Banner";
import { describeWarning, sourceParts, type AiOrigin } from "./ingestion-helpers";

export default function AiDraftBanner({ origin }: { origin: AiOrigin }) {
  const { lead, ref, href } = sourceParts(origin.source);
  return (
    <Banner tone="warning">
      <p>
        <strong>
          Drafted by AI from {lead}{" "}
          {href ? (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="break-all underline">
              {ref}
            </a>
          ) : (
            ref
          )}
          .
        </strong>{" "}
        Review every lesson before publishing.
      </p>
      {origin.warnings.length > 0 ? (
        <div className="mt-2 space-y-1">
          <p>Left out of the draft because they didn&rsquo;t pass the block checks:</p>
          <ul className="list-disc space-y-1 pl-5">
            {origin.warnings.map((w) => (
              <li key={`${w.lesson}-${w.position}`}>{describeWarning(w)}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </Banner>
  );
}
