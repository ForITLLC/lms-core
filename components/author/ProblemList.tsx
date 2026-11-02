import type { PublishProblem } from "@/lib/schema/draft";

export default function ProblemList({ problems }: { problems: PublishProblem[] }) {
  if (problems.length === 0) {
    return <p className="text-sm text-emerald-800">Nothing is stopping this draft from publishing.</p>;
  }
  return (
    <div className="space-y-2">
      <p className="text-sm font-semibold text-gray-900">
        {problems.length} thing{problems.length === 1 ? "" : "s"} to fix before publishing
      </p>
      <ul className="space-y-1 text-sm">
        {problems.map((p, i) => (
          <li key={`${p.where}:${i}`} className="text-gray-700">
            <span className="font-semibold text-gray-900">{p.where}:</span> {p.problem}
          </li>
        ))}
      </ul>
    </div>
  );
}
