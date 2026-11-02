import { z } from "zod";

export const CourseStatus = z.enum(["draft", "published", "archived"]);
export type CourseStatus = z.infer<typeof CourseStatus>;

export const Course = z.object({
  courseId: z.string().uuid(),
  tenantId: z.string(),
  title: z.string().min(1),
  slug: z.string().min(1),
  description: z.string().default(""),
  status: CourseStatus,
  createdAt: z.string().datetime(),
  createdBy: z.string(),
});

export type Course = z.infer<typeof Course>;
