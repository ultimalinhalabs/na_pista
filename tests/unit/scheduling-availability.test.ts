import assert from "node:assert/strict";
import test from "node:test";
import {
  BOOKING_INCREMENT_MINUTES,
  computeAvailability,
  computeStartTimes,
  computeWorkingIntervals,
  dayOfWeekForDate,
  findOverlappingPair,
  intervalsOverlap,
} from "../../src/modules/scheduling/availability.js";

/** ADR-039/040 — the pure availability engine, no DB, no I/O. */

test("intervalsOverlap: overlapping intervals are detected", () => {
  assert.equal(intervalsOverlap({ start: "08:00", end: "12:00" }, { start: "11:00", end: "14:00" }), true);
  assert.equal(intervalsOverlap({ start: "11:00", end: "14:00" }, { start: "08:00", end: "12:00" }), true, "order-independent");
});

test("intervalsOverlap: adjacent (touching) intervals do NOT count as overlap (docs/f26-report.md §8)", () => {
  assert.equal(intervalsOverlap({ start: "08:00", end: "12:00" }, { start: "12:00", end: "17:00" }), false);
});

test("intervalsOverlap: identical intervals overlap", () => {
  assert.equal(intervalsOverlap({ start: "08:00", end: "12:00" }, { start: "08:00", end: "12:00" }), true);
});

test("intervalsOverlap: one interval fully contained within another overlaps", () => {
  assert.equal(intervalsOverlap({ start: "08:00", end: "17:00" }, { start: "10:00", end: "11:00" }), true);
});

test("findOverlappingPair: returns null for a non-overlapping set (including adjacent intervals)", () => {
  assert.equal(findOverlappingPair([{ start: "08:00", end: "12:00" }, { start: "12:00", end: "17:00" }, { start: "18:00", end: "20:00" }]), null);
});

test("findOverlappingPair: finds the overlapping pair regardless of array position", () => {
  const result = findOverlappingPair([{ start: "08:00", end: "12:00" }, { start: "18:00", end: "20:00" }, { start: "11:00", end: "13:00" }]);
  assert.ok(result);
  assert.deepEqual(result![0], { start: "08:00", end: "12:00" });
  assert.deepEqual(result![1], { start: "11:00", end: "13:00" });
});

test("dayOfWeekForDate: is deterministic and independent of the server's own local timezone (parsed as UTC midnight)", () => {
  assert.equal(dayOfWeekForDate("2026-09-28"), 1, "2026-09-28 is a Monday");
  assert.equal(dayOfWeekForDate("2026-09-27"), 0, "2026-09-27 is a Sunday");
  assert.equal(dayOfWeekForDate("2026-10-03"), 6, "2026-10-03 is a Saturday");
});

test("computeWorkingIntervals: applies the weekly rule for a date with no exception", () => {
  const result = computeWorkingIntervals({
    rules: [
      { dayOfWeek: 1, startLocalTime: "08:00", endLocalTime: "12:00" },
      { dayOfWeek: 1, startLocalTime: "13:00", endLocalTime: "17:00" },
    ],
    exceptions: [],
    from: "2026-09-28",
    to: "2026-09-28",
  });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0]!.intervals, [
    { start: "08:00", end: "12:00" },
    { start: "13:00", end: "17:00" },
  ]);
});

test("computeWorkingIntervals: a day with no matching weekly rule is empty (closed day, ADR-039 D33)", () => {
  const result = computeWorkingIntervals({
    rules: [{ dayOfWeek: 1, startLocalTime: "08:00", endLocalTime: "17:00" }],
    exceptions: [],
    from: "2026-09-27", // a Sunday — no rule for dayOfWeek 0
    to: "2026-09-27",
  });
  assert.deepEqual(result[0]!.intervals, []);
});

test("computeWorkingIntervals: an exception COMPLETELY REPLACES the weekly rule for that date — never a merge (ADR-039 D4/D14, the F26 brief's own worked example)", () => {
  const result = computeWorkingIntervals({
    rules: [
      { dayOfWeek: 1, startLocalTime: "08:00", endLocalTime: "12:00" },
      { dayOfWeek: 1, startLocalTime: "13:00", endLocalTime: "17:00" },
    ],
    exceptions: [{ date: "2026-09-28", startLocalTime: "09:00", endLocalTime: "14:00" }],
    from: "2026-09-28",
    to: "2026-09-28",
  });
  assert.deepEqual(result[0]!.intervals, [{ start: "09:00", end: "14:00" }], "effective schedule is ONLY the exception's own interval, not 08-12+13-17+09-14");
});

test("computeWorkingIntervals: an exception can ADD availability on a normally-closed day", () => {
  const result = computeWorkingIntervals({
    rules: [{ dayOfWeek: 1, startLocalTime: "08:00", endLocalTime: "17:00" }], // Monday only
    exceptions: [{ date: "2026-09-27", startLocalTime: "10:00", endLocalTime: "14:00" }], // a Sunday, normally closed
    from: "2026-09-27",
    to: "2026-09-27",
  });
  assert.deepEqual(result[0]!.intervals, [{ start: "10:00", end: "14:00" }]);
});

test("computeWorkingIntervals: a closed-marker exception (both times null) removes all availability for that date", () => {
  const result = computeWorkingIntervals({
    rules: [{ dayOfWeek: 5, startLocalTime: "08:00", endLocalTime: "17:00" }], // Friday
    exceptions: [{ date: "2026-12-25", startLocalTime: null, endLocalTime: null }],
    from: "2026-12-25",
    to: "2026-12-25",
  });
  assert.deepEqual(result[0]!.intervals, []);
});

test("computeWorkingIntervals: multiple exception intervals for the same date are all effective, sorted", () => {
  const result = computeWorkingIntervals({
    rules: [],
    exceptions: [
      { date: "2026-09-28", startLocalTime: "14:00", endLocalTime: "16:00" },
      { date: "2026-09-28", startLocalTime: "09:00", endLocalTime: "11:00" },
    ],
    from: "2026-09-28",
    to: "2026-09-28",
  });
  assert.deepEqual(result[0]!.intervals, [
    { start: "09:00", end: "11:00" },
    { start: "14:00", end: "16:00" },
  ]);
});

test("computeWorkingIntervals: enumerates every date in an inclusive range", () => {
  const result = computeWorkingIntervals({ rules: [], exceptions: [], from: "2026-09-28", to: "2026-09-30" });
  assert.deepEqual(result.map((day) => day.date), ["2026-09-28", "2026-09-29", "2026-09-30"]);
});

test("computeStartTimes: generates start times stepped by BOOKING_INCREMENT_MINUTES where the full duration fits", () => {
  const result = computeStartTimes({ start: "08:00", end: "09:00" }, 30);
  assert.deepEqual(result, ["08:00", "08:15", "08:30"]);
  assert.equal(BOOKING_INCREMENT_MINUTES, 15);
});

test("computeStartTimes: an interval shorter than the duration yields zero start times (never a partial/truncated booking)", () => {
  assert.deepEqual(computeStartTimes({ start: "08:00", end: "08:20" }, 30), []);
});

test("computeStartTimes: a duration exactly equal to the interval yields exactly one start time", () => {
  assert.deepEqual(computeStartTimes({ start: "08:00", end: "08:30" }, 30), ["08:00"]);
});

test("computeAvailability: without a duration, returns working intervals only, no serviceStartTimes field", () => {
  const result = computeAvailability({
    rules: [{ dayOfWeek: 1, startLocalTime: "08:00", endLocalTime: "12:00" }],
    exceptions: [],
    from: "2026-09-28",
    to: "2026-09-28",
  });
  assert.deepEqual(result[0]!.workingIntervals, [{ start: "08:00", end: "12:00" }]);
  assert.equal(result[0]!.serviceStartTimes, undefined);
});

test("computeAvailability: with a duration, working intervals stay unfiltered AND serviceStartTimes is computed (working vs. service-aware are distinguished, never conflated — ADR-040 D14)", () => {
  const result = computeAvailability({
    rules: [{ dayOfWeek: 1, startLocalTime: "08:00", endLocalTime: "09:00" }],
    exceptions: [],
    from: "2026-09-28",
    to: "2026-09-28",
    durationMinutes: 60,
  });
  assert.deepEqual(result[0]!.workingIntervals, [{ start: "08:00", end: "09:00" }], "raw working interval is unaffected by the requested duration");
  assert.deepEqual(result[0]!.serviceStartTimes, ["08:00"], "only one 60-minute start fits inside a 08:00-09:00 interval");
});

test("computeAvailability: an interval too short for the service duration contributes zero serviceStartTimes but is still listed as a working interval", () => {
  const result = computeAvailability({
    rules: [{ dayOfWeek: 1, startLocalTime: "08:00", endLocalTime: "08:20" }],
    exceptions: [],
    from: "2026-09-28",
    to: "2026-09-28",
    durationMinutes: 60,
  });
  assert.deepEqual(result[0]!.workingIntervals, [{ start: "08:00", end: "08:20" }]);
  assert.deepEqual(result[0]!.serviceStartTimes, []);
});

test("computeAvailability: an archived/empty schedule produces empty working intervals for every date in range (fail-closed default, ADR-039 D33)", () => {
  const result = computeAvailability({ rules: [], exceptions: [], from: "2026-09-28", to: "2026-09-29" });
  assert.deepEqual(result[0]!.workingIntervals, []);
  assert.deepEqual(result[1]!.workingIntervals, []);
});
