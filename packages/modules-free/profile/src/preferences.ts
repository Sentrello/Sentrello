/**
 * What one person chose about how the application behaves for them.
 *
 * Every field is validated here rather than trusted from the request, because
 * these values are interpolated into dates, money and a landing route — a
 * timezone nobody checked throws inside `Intl` on somebody else's screen, and
 * a landing page nobody checked is a blank application after signing in.
 *
 * Two readers. `normalize` reads what is already stored, and anything it does
 * not recognise falls back to the default — a row written by an older version
 * must still draw a screen. `checkPreferences` reads a request, and refuses
 * what it does not recognise with a 400 naming the field: it was `normalize`
 * too, so "Mars/Olympus" or `{}` for a timezone saved as "the browser
 * decides" and answered 200, and the person was told it worked.
 */

import {
  RequestFieldError,
  asChoice,
  asTextOrNothing,
} from "@sentrello/db/request-values";

export interface Preferences {
  /** IANA name, e.g. "America/Denver". Empty means the browser decides. */
  timezone: string;
  dateFormat: "ISO" | "DMY" | "MDY";
  /**
   * ISO 4217, e.g. "USD". What money is shown in, not what it is stored as.
   *
   * Empty is the ordinary answer: the business's own books. Only somebody who
   * wants their employer's figures in a different currency sets this.
   */
  currency: string;
  /** Module id to open after signing in. Empty means whatever comes first. */
  landingPage: string;
  workingHours: { start: string; end: string; days: number[] };
}

export const DEFAULTS: Preferences = {
  timezone: "",
  dateFormat: "MDY",
  /*
   * Nothing, which means the currency the business keeps its books in.
   *
   * This was "USD", and it is read by every figure the shell draws without a
   * currency of its own — roughly a hundred of them, a dashboard and a report
   * and a summary card at a time. So on a British or Canadian instance all of
   * them were in dollars, correctly punctuated, until each person went to their
   * profile and typed three letters. Three of the four markets this sells into,
   * decided by a personal preference nobody knew they had.
   */
  currency: "",
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

  // Three letters, or nothing at all — which is the business's own currency and
  // what almost everybody wants. Anything else falls back to nothing, so a
  // person who types two letters reads their employer's figures rather than an
  // arbitrary third currency.
  const currency =
    typeof raw.currency === "string" && /^([A-Za-z]{3})?$/.test(raw.currency)
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

/**
 * Preferences from a request: each field present has to be one `normalize`
 * would keep, or the request is refused naming it. An absent field is the
 * default, as it always was — the screen sends the whole object.
 */
export function checkPreferences(input: unknown): Preferences {
  if (input === undefined || input === null) return DEFAULTS;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new RequestFieldError(
      "preferences",
      "preferences has to be an object.",
    );
  }
  const sent = input as Record<string, unknown>;
  const field = (name: string) => `preferences.${name}`;
  const refuse = (name: string, says: string): never => {
    throw new RequestFieldError(field(name), `${field(name)} ${says}.`);
  };

  const timezone = asTextOrNothing(sent.timezone, field("timezone")) ?? "";
  if (timezone !== "" && (timezone.length > 64 || !knownTimezone(timezone))) {
    refuse("timezone", "is not a timezone this server knows");
  }
  const dateFormat = asChoice(
    sent.dateFormat,
    field("dateFormat"),
    ["ISO", "DMY", "MDY"],
    DEFAULTS.dateFormat,
  );
  const currency = asTextOrNothing(sent.currency, field("currency")) ?? "";
  if (!/^([A-Za-z]{3})?$/.test(currency)) {
    refuse("currency", "has to be three letters, or nothing");
  }
  const landingPage =
    asTextOrNothing(sent.landingPage, field("landingPage")) ?? "";
  if (!/^[a-z0-9-]{0,40}$/.test(landingPage)) {
    refuse("landingPage", "is not a page");
  }

  const hours = sent.workingHours ?? {};
  if (typeof hours !== "object" || Array.isArray(hours)) {
    refuse("workingHours", "has to be an object");
  }
  const { start, end, days } = hours as Record<string, unknown>;
  const time = (value: unknown, name: string, fallback: string) => {
    const text = asTextOrNothing(value, field(`workingHours.${name}`));
    if (text === null) return fallback;
    if (!TIME.test(text))
      refuse(`workingHours.${name}`, "has to be like 09:00");
    return text;
  };
  let chosen = DEFAULTS.workingHours.days;
  if (days !== undefined && days !== null) {
    if (!Array.isArray(days)) refuse("workingHours.days", "has to be a list");
    const list = days as unknown[];
    if (
      !list.every(
        (d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6,
      )
    ) {
      refuse("workingHours.days", "has to hold days 0 to 6");
    }
    // A week with no working days is somebody who cleared the boxes by
    // accident, as `normalize` says.
    if (list.length)
      chosen = [...new Set(list as number[])].sort((a, b) => a - b);
  }

  return {
    timezone,
    dateFormat,
    currency: currency.toUpperCase(),
    landingPage,
    workingHours: {
      start: time(start, "start", DEFAULTS.workingHours.start),
      end: time(end, "end", DEFAULTS.workingHours.end),
      days: chosen,
    },
  };
}
