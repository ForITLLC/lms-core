"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const PROSE =
  "prose prose-slate max-w-none prose-headings:font-semibold prose-headings:text-gray-900 prose-pre:bg-gray-900 prose-pre:text-gray-100 prose-code:text-pink-700 prose-code:before:content-none prose-code:after:content-none prose-a:text-[color:var(--brand-primary)]";

export default function Markdown({
  children,
  className,
  size = "base",
}: {
  children: string;
  className?: string;
  /** `lg` steps the type up on large screens only. */
  size?: "base" | "lg";
}) {
  return (
    <div className={className ?? (size === "lg" ? `${PROSE} lg:prose-lg` : PROSE)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
