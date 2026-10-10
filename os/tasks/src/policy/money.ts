/** Money for the ordering pack: integer cents only, and spending limits enforced in code. */

export type Cents = number;

export function formatMoney(cents: Cents, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

export interface SpendingLimits {
  /** Largest single order the person allows without a caregiver raising the limit. */
  perOrderCents: Cents;
  /** Optional rolling daily limit across orders. */
  perDayCents?: Cents;
}

export const DEFAULT_LIMITS: SpendingLimits = { perOrderCents: 5000, perDayCents: 10000 };

export type LimitCheck = { ok: true } | { ok: false; message: string };

export function checkSpending(totalCents: Cents, spentTodayCents: Cents, limits: SpendingLimits): LimitCheck {
  if (!Number.isInteger(totalCents) || totalCents < 0)
    return { ok: false, message: "The total isn't a valid amount." };
  if (totalCents > limits.perOrderCents)
    return {
      ok: false,
      message: `This order is ${formatMoney(totalCents)}, over your limit of ${formatMoney(limits.perOrderCents)} per order. Remove something, or ask a helper to change the limit in Settings.`,
    };
  if (limits.perDayCents !== undefined && spentTodayCents + totalCents > limits.perDayCents)
    return {
      ok: false,
      message: `This would bring today's spending to ${formatMoney(spentTodayCents + totalCents)}, over your daily limit of ${formatMoney(limits.perDayCents)}.`,
    };
  return { ok: true };
}

/** Tip as a whole number of cents, rounded half up. */
export function tipCents(subtotalCents: Cents, percent: number): Cents {
  return Math.round((subtotalCents * percent) / 100);
}
