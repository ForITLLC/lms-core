export default function PackageNotice({ title }: { title: string }) {
  return (
    <div
      className="rounded-md border border-l-4 border-gray-200 bg-gray-50 p-6"
      style={{ borderLeftColor: "var(--brand-primary)" }}
    >
      <p
        className="text-xs uppercase tracking-wider font-semibold mb-2"
        style={{ color: "var(--brand-primary)" }}
      >
        Activity
      </p>
      <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
      <p className="mt-2 text-sm text-gray-600">
        This activity isn&rsquo;t available yet. It will open here once activities are switched on for
        this course.
      </p>
    </div>
  );
}
