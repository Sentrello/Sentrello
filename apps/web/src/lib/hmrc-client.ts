/**
 * What HMRC requires the browser to report about itself.
 *
 * Four of the sixteen fraud prevention headers can only come from here — the
 * screen size, the window size, the timezone and the real user agent. The
 * server cannot know them and HMRC refuses a submission without them, so they
 * are collected and posted with the return.
 *
 * Measured, never guessed. A plausible-looking value would be a false statement
 * to a tax authority about how a return was submitted, and the server leaves the
 * header out rather than inventing one — so an honest gap here becomes an honest
 * gap there.
 */
const DEVICE_KEY = "sentrello.hmrc.device";

/**
 * A stable id for this browser.
 *
 * HMRC wants to recognise the same device across submissions, which is the
 * point of the header. Generated once and kept: a new id every time would be
 * true of the value and useless for the purpose.
 */
function deviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing) return existing;
    const made = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, made);
    return made;
  } catch {
    // Private browsing, or storage refused. A fresh id is worse than a stable
    // one and better than none.
    return crypto.randomUUID();
  }
}

/** HMRC's timezone format: `UTC±hh:mm`, and the sign is the opposite of JS's. */
function timezone(): string {
  const offset = -new Date().getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const minutes = String(Math.abs(offset) % 60).padStart(2, "0");
  return `UTC${sign}${hours}:${minutes}`;
}

export function hmrcClientContext() {
  return {
    deviceId: deviceId(),
    screens:
      `width=${window.screen.width}&height=${window.screen.height}` +
      `&scaling-factor=${window.devicePixelRatio}` +
      `&colour-depth=${window.screen.colorDepth}`,
    windowSize: `width=${window.innerWidth}&height=${window.innerHeight}`,
    timezone: timezone(),
    userAgent: navigator.userAgent,
  };
}
