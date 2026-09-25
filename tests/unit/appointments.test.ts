import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import { roleHasPermission } from "../../src/authorization/permissions.js";
import { errorHandler } from "../../src/middleware/errorHandler.js";
import { computeBookableSlots, intervalsOverlap, isWithinAvailability, serviceStartTimesForDate, type ScheduleInput } from "../../src/modules/appointments/booking.js";
import { BOOKING_HORIZON_DAYS, assertTransition, assertWithinBookingWindow, isTerminal, occupiesTime } from "../../src/modules/appointments/lifecycle.js";
import {
  MAX_APPOINTMENT_LIST_DAYS,
  bookableSlotsQuerySchema,
  cancelAppointmentSchema,
  createAppointmentSchema,
  listAppointmentsQuerySchema,
  updateAppointmentSchema,
} from "../../src/modules/appointments/schemas.js";
import { buildBookingSnapshot } from "../../src/modules/appointments/snapshot.js";
import { addDays, inclusiveDayCount, localDateWindow, localToInstant, minutesBetween, toLocal } from "../../src/modules/appointments/time.js";
import {
  AppointmentCompletionTooEarlyError,
  BookingHorizonExceededError,
  InvalidAppointmentStateError,
  ValidationError,
  isExclusionViolationError,
} from "../../src/shared/errors.js";
import { DEFAULT_CURRENCY } from "../../src/shared/money.js";

/** F27 — pure Appointment logic: time conversion, lifecycle, booking-vs-availability, snapshots, schemas, permissions, error mapping. No DB. */

const UUID = "11111111-1111-4111-8111-111111111111";
const EVERY_DAY_8_TO_12: ScheduleInput = {
  rules: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, startLocalTime: "08:00", endLocalTime: "12:00" })),
  exceptions: [],
};

// ---------------- TIME ----------------

test("toLocal: an absolute instant becomes the organization's local date/time (Africa/Luanda, UTC+1, no DST)", () => {
  assert.deepEqual(toLocal(new Date("2026-10-05T08:00:00Z"), "Africa/Luanda"), { date: "2026-10-05", time: "09:00" });
});

test("toLocal: crossing local midnight moves to the NEXT local date (23:30Z = 00:30 next day in Luanda)", () => {
  assert.deepEqual(toLocal(new Date("2026-10-05T23:30:00Z"), "Africa/Luanda"), { date: "2026-10-06", time: "00:30" });
});

test("toLocal: the same instant reads differently in different organization timezones — the timezone is always explicit", () => {
  const instant = new Date("2026-07-01T12:00:00Z");
  assert.equal(toLocal(instant, "Africa/Luanda").time, "13:00");
  assert.equal(toLocal(instant, "America/Sao_Paulo").time, "09:00");
  assert.equal(toLocal(instant, "Asia/Tokyo").time, "21:00");
});

test("localToInstant: local wall clock -> UTC for a fixed-offset zone", () => {
  assert.equal(localToInstant("2026-10-05", "09:00", "Africa/Luanda")!.toISOString(), "2026-10-05T08:00:00.000Z");
});

test("localToInstant/toLocal round-trip for every 15-minute slot of a day (Luanda and Lisbon, non-transition day)", () => {
  for (const timeZone of ["Africa/Luanda", "Europe/Lisbon"]) {
    for (let minutes = 0; minutes < 24 * 60; minutes += 15) {
      const time = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
      const instant = localToInstant("2026-06-10", time, timeZone)!;
      assert.deepEqual(toLocal(instant, timeZone), { date: "2026-06-10", time }, `${timeZone} ${time}`);
    }
  }
});

test("DST gap (ADR-040): a nonexistent local time returns null by default (slot skipped) — Europe/Lisbon 2026-03-29 01:30", () => {
  assert.equal(localToInstant("2026-03-29", "01:30", "Europe/Lisbon"), null);
});

test("DST gap with gap='forward' lands on the post-transition instant (used only for day-window boundaries)", () => {
  assert.equal(localToInstant("2026-03-29", "01:30", "Europe/Lisbon", { gap: "forward" })!.toISOString(), "2026-03-29T01:30:00.000Z");
});

test("DST overlap (ADR-040): an ambiguous local time resolves to its FIRST (earlier) occurrence — Europe/Lisbon 2026-10-25 01:30", () => {
  assert.equal(localToInstant("2026-10-25", "01:30", "Europe/Lisbon")!.toISOString(), "2026-10-25T00:30:00.000Z");
});

test("DST: the instants either side of a transition are converted with the correct offset", () => {
  assert.equal(localToInstant("2026-03-29", "00:30", "Europe/Lisbon")!.toISOString(), "2026-03-29T00:30:00.000Z", "WET +0 before");
  assert.equal(localToInstant("2026-03-29", "02:30", "Europe/Lisbon")!.toISOString(), "2026-03-29T01:30:00.000Z", "WEST +1 after");
});

test("invalid timezone: conversion throws (RangeError) — never a silent fallback to UTC/server time", () => {
  assert.throws(() => toLocal(new Date(), "Not/AZone"), RangeError);
  assert.throws(() => localToInstant("2026-10-05", "09:00", "Not/AZone"), RangeError);
});

test("localDateWindow: inclusive local dates become one absolute half-open window", () => {
  const window = localDateWindow("2026-10-05", "2026-10-06", "Africa/Luanda");
  assert.equal(window.start.toISOString(), "2026-10-04T23:00:00.000Z");
  assert.equal(window.end.toISOString(), "2026-10-06T23:00:00.000Z");
});

test("localDateWindow across a DST change is 23 hours long, not 24 (Lisbon spring-forward day)", () => {
  const window = localDateWindow("2026-03-29", "2026-03-29", "Europe/Lisbon");
  assert.equal(minutesBetween(window.start, window.end), 23 * 60);
});

test("addDays / inclusiveDayCount: calendar arithmetic across month/year boundaries", () => {
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(inclusiveDayCount("2026-10-01", "2026-10-01"), 1);
  assert.equal(inclusiveDayCount("2026-10-01", "2026-10-31"), 31);
});

// ---------------- HORIZON ----------------

test("booking window: now itself and exactly now+365d are allowed (inclusive bounds)", () => {
  const now = new Date("2026-10-01T10:00:00Z");
  assert.doesNotThrow(() => assertWithinBookingWindow(now, now));
  assert.doesNotThrow(() => assertWithinBookingWindow(new Date(now.getTime() + BOOKING_HORIZON_DAYS * 86_400_000), now));
});

test("booking window: one minute beyond 365 days -> BookingHorizonExceededError (400 BOOKING_HORIZON_EXCEEDED)", () => {
  const now = new Date("2026-10-01T10:00:00Z");
  const error = (() => {
    try {
      assertWithinBookingWindow(new Date(now.getTime() + BOOKING_HORIZON_DAYS * 86_400_000 + 60_000), now);
    } catch (e) {
      return e;
    }
  })();
  assert.ok(error instanceof BookingHorizonExceededError);
  assert.equal(error.statusCode, 400);
  assert.equal(error.code, "BOOKING_HORIZON_EXCEEDED");
});

test("booking window: a start in the past is rejected (ValidationError)", () => {
  const now = new Date("2026-10-01T10:00:00Z");
  assert.throws(() => assertWithinBookingWindow(new Date("2026-10-01T09:59:00Z"), now), ValidationError);
});

test("booking window is instant-based: the same instant spelled with different offsets gets the same verdict", () => {
  const now = new Date("2026-10-01T10:00:00Z");
  const limit = new Date(now.getTime() + BOOKING_HORIZON_DAYS * 86_400_000);
  const spelledInPlus14 = createAppointmentSchema.parse({ customerId: UUID, professionalId: UUID, serviceId: UUID, startAt: "2027-10-02T00:00:00+14:00" }).startAt;
  assert.equal(spelledInPlus14.getTime(), limit.getTime(), "+14:00 spelling is exactly the horizon instant");
  assert.doesNotThrow(() => assertWithinBookingWindow(spelledInPlus14, now));
});

// ---------------- LIFECYCLE ----------------

test("lifecycle: SCHEDULED -> cancel -> CANCELED", () => {
  assert.equal(assertTransition("SCHEDULED", "cancel"), "CANCELED");
});

test("lifecycle: SCHEDULED -> complete -> COMPLETED once now >= start_at (exactly at start is allowed)", () => {
  const startAt = new Date("2026-10-05T08:00:00Z");
  assert.equal(assertTransition("SCHEDULED", "complete", { now: startAt, startAt }), "COMPLETED");
  assert.equal(assertTransition("SCHEDULED", "complete", { now: new Date("2026-10-05T08:10:00Z"), startAt }), "COMPLETED", "before end_at is fine — sessions can end early");
});

test("lifecycle: completing before start_at -> AppointmentCompletionTooEarlyError (409 APPOINTMENT_COMPLETION_TOO_EARLY)", () => {
  const startAt = new Date("2026-10-05T08:00:00Z");
  assert.throws(() => assertTransition("SCHEDULED", "complete", { now: new Date("2026-10-05T07:59:00Z"), startAt }), AppointmentCompletionTooEarlyError);
});

test("lifecycle: SCHEDULED -> reschedule/update stay SCHEDULED", () => {
  assert.equal(assertTransition("SCHEDULED", "reschedule"), "SCHEDULED");
  assert.equal(assertTransition("SCHEDULED", "update"), "SCHEDULED");
});

test("lifecycle: terminal states reject EVERY action (no resurrection, no edits, no double cancel/complete)", () => {
  const context = { now: new Date("2030-01-01T00:00:00Z"), startAt: new Date("2026-01-01T00:00:00Z") };
  for (const status of ["CANCELED", "COMPLETED"] as const) {
    for (const action of ["reschedule", "update", "cancel", "complete"] as const) {
      assert.throws(() => assertTransition(status, action, context), InvalidAppointmentStateError, `${status} -> ${action}`);
    }
    assert.equal(isTerminal(status), true);
  }
  assert.equal(isTerminal("SCHEDULED"), false);
});

test("lifecycle: occupancy mirrors the DB predicate status <> 'CANCELED' — SCHEDULED and COMPLETED occupy, CANCELED releases", () => {
  assert.equal(occupiesTime("SCHEDULED"), true);
  assert.equal(occupiesTime("COMPLETED"), true);
  assert.equal(occupiesTime("CANCELED"), false);
});

// ---------------- AVAILABILITY / BOOKING ----------------

test("availability reuse: serviceStartTimesForDate returns F26's own serviceStartTimes (15-min grid, duration must fit)", () => {
  assert.deepEqual(serviceStartTimesForDate(EVERY_DAY_8_TO_12, "2026-10-05", 60), [
    "08:00", "08:15", "08:30", "08:45", "09:00", "09:15", "09:30", "09:45", "10:00", "10:15", "10:30", "10:45", "11:00",
  ]);
});

test("isWithinAvailability: a valid slot (Luanda 09:00 local = 08:00Z) is accepted", () => {
  assert.equal(isWithinAvailability(EVERY_DAY_8_TO_12, new Date("2026-10-05T08:00:00Z"), 60, "Africa/Luanda"), true);
});

test("isWithinAvailability: duration overflowing the working interval is rejected (11:30 + 60min > 12:00)", () => {
  assert.equal(isWithinAvailability(EVERY_DAY_8_TO_12, new Date("2026-10-05T10:30:00Z"), 60, "Africa/Luanda"), false);
  assert.equal(isWithinAvailability(EVERY_DAY_8_TO_12, new Date("2026-10-05T10:30:00Z"), 30, "Africa/Luanda"), true, "a 30-min service fits at 11:30");
});

test("isWithinAvailability: off-grid start (09:10) and outside working hours (13:00) are rejected", () => {
  assert.equal(isWithinAvailability(EVERY_DAY_8_TO_12, new Date("2026-10-05T08:10:00Z"), 30, "Africa/Luanda"), false);
  assert.equal(isWithinAvailability(EVERY_DAY_8_TO_12, new Date("2026-10-05T12:00:00Z"), 30, "Africa/Luanda"), false);
});

test("isWithinAvailability: the timezone decides the local time — the same instant is valid in Luanda, invalid in Tokyo", () => {
  assert.equal(isWithinAvailability(EVERY_DAY_8_TO_12, new Date("2026-10-05T08:00:00Z"), 60, "Africa/Luanda"), true);
  assert.equal(isWithinAvailability(EVERY_DAY_8_TO_12, new Date("2026-10-05T08:00:00Z"), 60, "Asia/Tokyo"), false, "17:00 in Tokyo");
});

test("isWithinAvailability: an exception closed-marker makes the whole date unavailable; an exception interval replaces the weekly rule", () => {
  const closed: ScheduleInput = { ...EVERY_DAY_8_TO_12, exceptions: [{ date: "2026-10-05", startLocalTime: null, endLocalTime: null }] };
  assert.equal(isWithinAvailability(closed, new Date("2026-10-05T08:00:00Z"), 60, "Africa/Luanda"), false);
  const opened: ScheduleInput = { ...EVERY_DAY_8_TO_12, exceptions: [{ date: "2026-10-05", startLocalTime: "18:00", endLocalTime: "20:00" }] };
  assert.equal(isWithinAvailability(opened, new Date("2026-10-05T17:00:00Z"), 60, "Africa/Luanda"), true, "18:00 local via exception");
  assert.equal(isWithinAvailability(opened, new Date("2026-10-05T08:00:00Z"), 60, "Africa/Luanda"), false, "weekly 09:00 no longer applies");
});

test("overlap semantics [start, end): adjacent intervals do NOT overlap; partial and identical do", () => {
  const a = { startAt: new Date("2026-10-05T09:00:00Z"), endAt: new Date("2026-10-05T10:00:00Z") };
  assert.equal(intervalsOverlap(a, { startAt: new Date("2026-10-05T10:00:00Z"), endAt: new Date("2026-10-05T11:00:00Z") }), false);
  assert.equal(intervalsOverlap(a, { startAt: new Date("2026-10-05T09:30:00Z"), endAt: new Date("2026-10-05T10:30:00Z") }), true);
  assert.equal(intervalsOverlap(a, a), true);
});

test("computeBookableSlots: removes slots overlapping occupied appointments, keeps adjacent ones, returns absolute instants", () => {
  const slots = computeBookableSlots({
    schedule: EVERY_DAY_8_TO_12,
    date: "2026-10-05",
    durationMinutes: 60,
    timeZone: "Africa/Luanda",
    occupied: [{ startAt: new Date("2026-10-05T08:00:00Z"), endAt: new Date("2026-10-05T09:00:00Z") }], // 09:00-10:00 local
    now: new Date("2026-10-01T00:00:00Z"),
    horizonEnd: new Date("2027-10-01T00:00:00Z"),
  });
  const times = slots.map((slot) => slot.localStartTime);
  assert.deepEqual(times, ["08:00", "10:00", "10:15", "10:30", "10:45", "11:00"], "08:00 ends exactly at 09:00 (adjacent, kept); 08:15-09:45 overlap, removed");
  assert.equal(slots[0]!.startAt.toISOString(), "2026-10-05T07:00:00.000Z");
  assert.equal(slots[0]!.endAt.toISOString(), "2026-10-05T08:00:00.000Z");
});

test("computeBookableSlots: slots in the past or beyond the horizon are omitted (creation would reject them)", () => {
  const slots = computeBookableSlots({
    schedule: EVERY_DAY_8_TO_12,
    date: "2026-10-05",
    durationMinutes: 60,
    timeZone: "Africa/Luanda",
    occupied: [],
    now: new Date("2026-10-05T09:00:00Z"), // 10:00 local
    horizonEnd: new Date("2026-10-05T09:30:00Z"), // 10:30 local
  });
  assert.deepEqual(slots.map((slot) => slot.localStartTime), ["10:00", "10:15", "10:30"]);
});

test("computeBookableSlots: no schedule -> no slots (fail-closed, ADR-039 D33)", () => {
  const slots = computeBookableSlots({
    schedule: { rules: [], exceptions: [] },
    date: "2026-10-05",
    durationMinutes: 30,
    timeZone: "Africa/Luanda",
    occupied: [],
    now: new Date("2026-10-01T00:00:00Z"),
    horizonEnd: new Date("2027-10-01T00:00:00Z"),
  });
  assert.deepEqual(slots, []);
});

test("computeBookableSlots: a start time inside a DST gap is skipped, never shifted (Lisbon 2026-03-29, 01:00-03:00 working)", () => {
  const slots = computeBookableSlots({
    schedule: { rules: [{ dayOfWeek: 0, startLocalTime: "00:00", endLocalTime: "03:00" }], exceptions: [] },
    date: "2026-03-29",
    durationMinutes: 30,
    timeZone: "Europe/Lisbon",
    occupied: [],
    now: new Date("2026-03-01T00:00:00Z"),
    horizonEnd: new Date("2027-03-01T00:00:00Z"),
  });
  const times = slots.map((slot) => slot.localStartTime);
  assert.ok(!times.includes("01:00") && !times.includes("01:15") && !times.includes("01:30") && !times.includes("01:45"), "01:xx does not exist that night");
  assert.ok(times.includes("00:45") && times.includes("02:00"));
});

// ---------------- SNAPSHOT / DURATION / MONEY ----------------

test("snapshot: name, price, currency and the interval are frozen from the Service at booking time", () => {
  const startAt = new Date("2026-10-05T08:00:00Z");
  const snapshot = buildBookingSnapshot({ name: "Personal Training", price: "10000.00", durationMinutes: 60 }, startAt);
  assert.deepEqual(snapshot, {
    serviceName: "Personal Training",
    servicePrice: "10000.00",
    currency: DEFAULT_CURRENCY,
    startAt,
    endAt: new Date("2026-10-05T09:00:00Z"),
  });
  assert.equal(minutesBetween(snapshot.startAt, snapshot.endAt), 60, "duration = end_at - start_at");
});

test("snapshot: an unpriced Service (price NULL) is bookable and stays NULL — never coerced to 0", () => {
  const snapshot = buildBookingSnapshot({ name: "Avaliação", price: null, durationMinutes: 30 }, new Date("2026-10-05T08:00:00Z"));
  assert.equal(snapshot.servicePrice, null);
  assert.equal(snapshot.currency, "AOA");
});

test("snapshot: price stays a decimal string (ADR-029) — no float conversion", () => {
  const snapshot = buildBookingSnapshot({ name: "X", price: "0.10", durationMinutes: 15 }, new Date("2026-10-05T08:00:00Z"));
  assert.equal(snapshot.servicePrice, "0.10");
});

// ---------------- SCHEMAS ----------------

const validCreate = { customerId: UUID, professionalId: UUID, serviceId: UUID, startAt: "2026-10-05T08:00:00Z" };

test("createAppointmentSchema: requires customer, professional, service and startAt (all four)", () => {
  assert.equal(createAppointmentSchema.safeParse(validCreate).success, true);
  for (const key of ["customerId", "professionalId", "serviceId", "startAt"] as const) {
    const { [key]: _omitted, ...rest } = validCreate;
    assert.equal(createAppointmentSchema.safeParse(rest).success, false, `${key} missing must be rejected`);
  }
});

test("createAppointmentSchema: server-derived fields cannot be supplied (.strict())", () => {
  for (const extra of [{ endAt: "2026-10-05T09:00:00Z" }, { status: "COMPLETED" }, { servicePrice: "1" }, { serviceName: "x" }, { currency: "USD" }, { organizationId: UUID }, { durationMinutes: 5 }]) {
    assert.equal(createAppointmentSchema.safeParse({ ...validCreate, ...extra }).success, false, JSON.stringify(extra));
  }
});

test("createAppointmentSchema: startAt must carry Z or an explicit offset; bare local strings are ambiguous and rejected", () => {
  assert.equal(createAppointmentSchema.safeParse({ ...validCreate, startAt: "2026-10-05T09:00:00+01:00" }).success, true);
  assert.equal(createAppointmentSchema.safeParse({ ...validCreate, startAt: "2026-10-05T09:00:00" }).success, false);
  assert.equal(createAppointmentSchema.safeParse({ ...validCreate, startAt: "2026-10-05" }).success, false);
  assert.equal(createAppointmentSchema.safeParse({ ...validCreate, startAt: "09:00" }).success, false);
});

test("createAppointmentSchema: startAt must be a whole minute", () => {
  assert.equal(createAppointmentSchema.safeParse({ ...validCreate, startAt: "2026-10-05T08:00:30Z" }).success, false);
  assert.equal(createAppointmentSchema.safeParse({ ...validCreate, startAt: "2026-10-05T08:00:00.500Z" }).success, false);
});

test("createAppointmentSchema: notes ≤ 2000 chars; whitespace-only becomes null", () => {
  assert.equal(createAppointmentSchema.safeParse({ ...validCreate, notes: "x".repeat(2001) }).success, false);
  assert.equal(createAppointmentSchema.parse({ ...validCreate, notes: "   " }).notes, null);
  assert.equal(createAppointmentSchema.parse({ ...validCreate, notes: " ok " }).notes, "ok");
});

test("updateAppointmentSchema: customerId, serviceId, status, endAt are NOT patchable (no customer mutation, no status bypass)", () => {
  for (const forbidden of [{ customerId: UUID }, { serviceId: UUID }, { status: "COMPLETED" }, { status: "CANCELED" }, { endAt: "2026-10-05T09:00:00Z" }]) {
    assert.equal(updateAppointmentSchema.safeParse(forbidden).success, false, JSON.stringify(forbidden));
  }
});

test("updateAppointmentSchema: startAt/professionalId/notes accepted; notes may be null; empty body rejected", () => {
  assert.equal(updateAppointmentSchema.safeParse({ startAt: "2026-10-05T08:00:00Z" }).success, true);
  assert.equal(updateAppointmentSchema.safeParse({ professionalId: UUID }).success, true);
  assert.equal(updateAppointmentSchema.safeParse({ notes: null }).success, true);
  assert.equal(updateAppointmentSchema.safeParse({}).success, false);
});

test("cancelAppointmentSchema: optional reason, 1-500 chars", () => {
  assert.equal(cancelAppointmentSchema.safeParse({}).success, true);
  assert.equal(cancelAppointmentSchema.safeParse({ reason: "Cliente pediu" }).success, true);
  assert.equal(cancelAppointmentSchema.safeParse({ reason: "" }).success, false);
  assert.equal(cancelAppointmentSchema.safeParse({ reason: "x".repeat(501) }).success, false);
  assert.equal(cancelAppointmentSchema.safeParse({ status: "CANCELED" }).success, false);
});

test("listAppointmentsQuerySchema: from/to REQUIRED; max 31 inclusive days; to >= from; limit ≤ 500 default 200", () => {
  assert.equal(listAppointmentsQuerySchema.safeParse({}).success, false, "unbounded listing is impossible");
  assert.equal(listAppointmentsQuerySchema.safeParse({ from: "2026-10-01" }).success, false);
  assert.equal(listAppointmentsQuerySchema.safeParse({ from: "2026-10-01", to: "2026-10-31" }).success, true, "31 days");
  assert.equal(listAppointmentsQuerySchema.safeParse({ from: "2026-10-01", to: "2026-11-01" }).success, false, "32 days");
  assert.equal(listAppointmentsQuerySchema.safeParse({ from: "2026-10-02", to: "2026-10-01" }).success, false);
  assert.equal(listAppointmentsQuerySchema.safeParse({ from: "2026-10-01", to: "2026-10-01", limit: "501" }).success, false);
  assert.equal(listAppointmentsQuerySchema.parse({ from: "2026-10-01", to: "2026-10-01" }).limit, 200);
  assert.equal(MAX_APPOINTMENT_LIST_DAYS, 31);
});

test("listAppointmentsQuerySchema: filters validated; impossible dates rejected; unknown params rejected", () => {
  assert.equal(listAppointmentsQuerySchema.safeParse({ from: "2026-10-01", to: "2026-10-01", status: "CANCELED", professionalId: UUID, customerId: UUID, serviceId: UUID }).success, true);
  assert.equal(listAppointmentsQuerySchema.safeParse({ from: "2026-10-01", to: "2026-10-01", status: "NO_SHOW" }).success, false);
  assert.equal(listAppointmentsQuerySchema.safeParse({ from: "2026-02-30", to: "2026-03-01" }).success, false);
  assert.equal(listAppointmentsQuerySchema.safeParse({ from: "2026-10-01", to: "2026-10-01", organizationId: UUID }).success, false);
});

test("bookableSlotsQuerySchema: date and serviceId both required", () => {
  assert.equal(bookableSlotsQuerySchema.safeParse({ date: "2026-10-05", serviceId: UUID }).success, true);
  assert.equal(bookableSlotsQuerySchema.safeParse({ date: "2026-10-05" }).success, false);
  assert.equal(bookableSlotsQuerySchema.safeParse({ serviceId: UUID }).success, false);
});

// ---------------- PERMISSIONS ----------------

test("permissions: OWNER/ADMIN/MANAGER read+create+update; STAFF read only; nobody has appointments.delete", () => {
  for (const role of ["OWNER", "ADMIN", "MANAGER"]) {
    for (const permission of ["appointments.read", "appointments.create", "appointments.update"]) {
      assert.equal(roleHasPermission(role, permission), true, `${role} ${permission}`);
    }
  }
  assert.equal(roleHasPermission("STAFF", "appointments.read"), true);
  assert.equal(roleHasPermission("STAFF", "appointments.create"), false);
  assert.equal(roleHasPermission("STAFF", "appointments.update"), false);
  for (const role of ["OWNER", "ADMIN", "MANAGER", "STAFF"]) assert.equal(roleHasPermission(role, "appointments.delete"), false);
});

// ---------------- ERROR MAPPING ----------------

function drizzleWrapped(code: string, constraint: string) {
  const driverError = Object.assign(new Error("conflicting key value violates exclusion constraint"), { code, constraint_name: constraint });
  return Object.assign(new Error("Failed query: insert into ..."), { cause: driverError });
}

test("isExclusionViolationError: finds 23P01 + constraint name through drizzle's cause chain; ignores other codes/constraints", () => {
  const error = drizzleWrapped("23P01", "appointments_professional_no_overlap");
  assert.equal(isExclusionViolationError(error), true);
  assert.equal(isExclusionViolationError(error, "appointments_professional_no_overlap"), true);
  assert.equal(isExclusionViolationError(error, "some_other_constraint"), false);
  assert.equal(isExclusionViolationError(drizzleWrapped("23505", "x")), false);
  assert.equal(isExclusionViolationError(null), false);
});

function captureResponse() {
  const captured: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
  } as unknown as Response;
  return { res, captured };
}

test("errorHandler: an untranslated exclusion violation is a 409 CONFLICT with a generic message — no constraint name, no SQL", () => {
  const { res, captured } = captureResponse();
  errorHandler(drizzleWrapped("23P01", "appointments_professional_no_overlap"), { requestId: "r", path: "/x" } as unknown as Request, res, () => {});
  assert.equal(captured.status, 409);
  assert.deepEqual(captured.body, { error: { code: "CONFLICT", message: "Conflicting resource state" } });
  assert.doesNotMatch(JSON.stringify(captured.body), /appointments_professional_no_overlap|exclusion|insert/i);
});
