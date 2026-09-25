import { DEFAULT_CURRENCY } from "../../shared/money.js";
import { addMinutes } from "./time.js";

/**
 * F27 (ADR-034/042): everything an Appointment freezes from the Service at
 * booking time — name, price (NULL stays NULL: an unpriced Service is
 * bookable), the single operating currency (ADR-030), and the interval
 * `[startAt, startAt + durationMinutes)`. Called ONCE, at creation. A
 * reschedule never calls it again: it moves the same booking, it does not
 * re-quote or re-time it.
 */
export function buildBookingSnapshot(service: { name: string; price: string | null; durationMinutes: number }, startAt: Date) {
  return {
    serviceName: service.name,
    servicePrice: service.price,
    currency: DEFAULT_CURRENCY,
    startAt,
    endAt: addMinutes(startAt, service.durationMinutes),
  };
}
