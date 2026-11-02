import type { CourseSeed } from "@/db/seed/course-seed";
import { lesson as lesson1 } from "@/db/seed/courses/_account-security-l1";
import { lesson as lesson2 } from "@/db/seed/courses/_account-security-l2";
import { lesson as lesson3 } from "@/db/seed/courses/_account-security-l3";
import { lesson as lesson4 } from "@/db/seed/courses/_account-security-l4";

const course: CourseSeed = {
  slug: "account-security-fundamentals",
  title: "Account Security: 1Password, Passkeys & MFA",
  description:
    "Set up the four habits that stop an attacker even when your password leaks: a password manager, a passkey, an authenticator app, and a locked-down device.",
  category: "security",
  mandatory: true,
  scheduleKind: "annual",
  tags: ["security", "passwords", "mfa", "1password", "passkeys", "compliance", "annual"],
  lessons: [lesson1, lesson2, lesson3, lesson4],
};

export default course;
