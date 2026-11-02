import type { NavItem } from "./MobileNav";
import { isStaffRole } from "@/lib/auth/roles";
import { canMarkExams, canReadRecords } from "@/lib/auth/records-permissions";

// The header links for a signed-in session. Staff get the author tools and
// /admin; an instructor or a training manager, who can open neither, gets
// the two pages their role opens instead.
export function navItemsFor(role: string | undefined): NavItem[] {
  const items: NavItem[] = [
    { href: "/dashboard", label: "Dashboard" },
    { href: "/dashboard/summary", label: "Summary" },
    { href: "/learn", label: "Learn" },
    { href: "/drill", label: "Drill" },
    { href: "/dashboard/settings", label: "Settings" },
  ];
  if (isStaffRole(role)) {
    items.push({ href: "/author", label: "Author" }, { href: "/admin", label: "Admin" });
  } else {
    if (canReadRecords(role)) items.push({ href: "/admin/records", label: "Training records" });
    if (canMarkExams(role)) items.push({ href: "/author/grading", label: "Marking" });
  }
  items.push({ href: "/api/auth/logout", label: "Sign out" });
  return items;
}
