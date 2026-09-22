import { timestamp } from "drizzle-orm/pg-core";

/** Same `createdAt`/`updatedAt` convention ul-platform's own schema uses. */
export const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};
