"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

export interface NavItem {
  href: string;
  label: string;
}

export default function MobileNav({
  items,
  email,
}: {
  items: NavItem[];
  email?: string;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        aria-label="Open navigation menu"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="md:hidden inline-flex items-center justify-center rounded-md w-9 h-9 bg-white/10 hover:bg-white/20 transition-colors"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          className="w-5 h-5"
        >
          <line x1="4" y1="7" x2="20" y2="7" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <line x1="4" y1="17" x2="20" y2="17" />
        </svg>
      </button>

      {open && (
        <div
          className="md:hidden fixed inset-0 z-[100]"
          role="dialog"
          aria-modal="true"
        >
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/50"
          />
          <div className="absolute top-0 right-0 h-full w-72 max-w-[85vw] bg-white shadow-xl flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
              <span className="text-sm font-semibold text-gray-700">Menu</span>
              <button
                type="button"
                aria-label="Close navigation menu"
                onClick={() => setOpen(false)}
                className="inline-flex items-center justify-center rounded-md w-9 h-9 text-gray-500 hover:bg-gray-100"
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  className="w-5 h-5"
                >
                  <line x1="6" y1="6" x2="18" y2="18" />
                  <line x1="6" y1="18" x2="18" y2="6" />
                </svg>
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto py-2">
              {items.map((it) => (
                <Link
                  key={it.href}
                  href={it.href}
                  prefetch={false}
                  onClick={() => setOpen(false)}
                  className="block px-4 py-3 text-sm font-medium text-gray-800 hover:bg-gray-100"
                >
                  {it.label}
                </Link>
              ))}
            </nav>
            {email && (
              <div className="px-4 py-3 border-t border-gray-200 text-xs text-gray-500 truncate">
                {email}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
