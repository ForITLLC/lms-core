import type { Role } from "@/lib/auth-config";

const ROLES: readonly Role[] = ["admin", "author", "learner", "instructor", "training_manager"];

// A missing or unrecognised role reads as learner, so a bad row never grants staff access.
export function asRole(value: string | null | undefined): Role {
  return ROLES.find((role) => role === value) ?? "learner";
}

// The course builder, /admin and the tenant's settings. The instructor and
// training-manager roles are not staff: their rights are in
// lib/auth/records-permissions.ts.
export function isStaffRole(role: string | null | undefined): boolean {
  return role === "admin" || role === "author";
}
