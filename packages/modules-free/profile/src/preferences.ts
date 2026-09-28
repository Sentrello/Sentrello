/**
 * What one person chose about how the application behaves for them.
 *
 * Every field is validated here rather than trusted from the request, because
 * these values are interpolated into dates, money and a landing route — a
 * timezone nobody checked throws inside `Intl` on somebody else's screen, and
 * a landing page nobody checked is a blank application after signing in.
 *
 * Anything invalid falls back to the default rather than being rejected. A
 * preferences screen that refuses to save because one field is odd is a
 * preferences screen people stop using.
 */

export interface Preferences {
  /** IANA name, e.g. "America/Denver". Empty means the browser decides. */
  timezone: string;
  dateFormat: "ISO" | "DMY" | "MDY";
  /** ISO 4217, e.g. "USD". What money is shown in, not what it is stored as. */
  currency: string;
  /** Module id to open after signing in. Empty means whatever comes first. */
  landingPage: string;
  workingHours: { start: string; end: string; days: number[] };
}

export const DEFAULTS: Preferences = {
  timezone: "",
  dateFormat: "MDY",
  currency: "USD",
  landingPage: "",
  // Monday to Friday, nine to five. Wrong for a lot of trades, which is why it
  // is a preference — but it is the answer that needs changing least often.
  workingHours: { start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5] },
};

/** Whether `Intl` will actually accept this timezone on this machine. */
function knownTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function normalize(input: unknown): Preferences {
  const raw = (input ?? {}) as Partial<Record<keyof Preferences, unknown>>;

  const timezone =
    typeof raw.timezone === "string" &&
    raw.timezone.length <= 64 &&
    (raw.timezone === "" || knownTimezone(raw.timezone))
      ? raw.timezone
      : DEFAULTS.timezone;

  const dateFormat =
    raw.dateFormat === "ISO" ||
    raw.dateFormat === "DMY" ||
    raw.dateFormat === "MDY"
      ? raw.dateFormat
      : DEFAULTS.dateFormat;

  const currency =
    typeof raw.currency === "string" && /^[A-Za-z]{3}$/.test(raw.currency)
      ? raw.currency.toUpperCase()
      : DEFAULTS.currency;

  const landingPage =
    typeof raw.landingPage === "string" &&
    /^[a-z0-9-]{0,40}$/.test(raw.landingPage)
      ? raw.landingPage
      : DEFAULTS.landingPage;

  const hours = (raw.workingHours ?? {}) as {
    start?: unknown;
    end?: unknown;
    days?: unknown;
  };
  const start =
    typeof hours.start === "string" && TIME.test(hours.start)
      ? hours.start
      : DEFAULTS.workingHours.start;
  const end =
    typeof hours.end === "string" && TIME.test(hours.end)
      ? hours.end
      : DEFAULTS.workingHours.end;
  const days = Array.isArray(hours.days)
    ? [
        ...new Set(
          hours.days.filter(
            (d): d is number => Number.isInteger(d) && d >= 0 && d <= 6,
          ),
        ),
      ].sort((a, b) => a - b)
    : DEFAULTS.workingHours.days;

  return {
    timezone,
    dateFormat,
    currency,
    landingPage,
    // A week with no working days at all is somebody who cleared the boxes by
    // accident; it would make every "is this overdue" question meaningless.
    workingHours: {
      start,
      end,
      days: days.length ? days : DEFAULTS.workingHours.days,
    },
  };
}
