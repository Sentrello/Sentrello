/**
 * The platform's own icons.
 *
 * Drawn here rather than taken from a library, for the reason James gave on
 * 2026-09-20: an icon should look like the thing it opens. A general-purpose
 * set cannot do that — it has one glyph for "users" and this platform has
 * two different screens that deserve one each, one glyph for "boxes" where
 * the rail needs Licences and Projects to be told apart at 20 pixels, and
 * nothing at all for a VAT return.
 *
 * **Twelve names were being asked for and not drawn.** `landmark`,
 * `book-open`, `link`, `credit-card`, `calculator`, `bolt` and six others
 * fell through to the fallback, so the tax returns, the books, the Links
 * module, Workflows, Formulas and the POS were each drawing the same blank
 * grid square. Nothing errored; every one of those nav entries simply had no
 * picture, which is the kind of fault that survives a year.
 *
 * ## How they are drawn
 *
 * One grid, so a row of them reads as a set rather than as a collection:
 *
 * - **24×24, with the drawing inside 3–21.** Two units of air on every side,
 *   so nothing touches the edge and every glyph has the same optical weight.
 * - **Strokes, not fills.** `currentColor`, 1.75 wide, round caps and joins.
 *   Fills are reserved for a dot small enough that a stroke would close up.
 * - **A second, quieter stroke carries the detail** — the lines on a
 *   document, the teeth of a gear, the shadow of a stacked box. Drawn at half
 *   opacity, the same idiom the marketing site's hand-drawn marks use: the
 *   shape reads at 16px and the detail rewards 24.
 * - **No text, ever.** A letterform in an icon is a translation problem.
 */

export interface Glyph {
  /** The strokes that carry the shape. */
  d: string[];
  /** Detail: drawn at half opacity, and never the thing that identifies it. */
  faint?: string[];
  /** Small solid marks — a pupil, a bullet, a coin's centre. */
  dots?: [number, number, number][];
}

export const GLYPHS: Record<string, Glyph> = {
  // --- Getting around ------------------------------------------------------
  "chevron-right": { d: ["M9.5 5.5 16 12l-6.5 6.5"] },
  "chevron-down": { d: ["M5.5 9.5 12 16l6.5-6.5"] },
  /** The panel, with its rail still standing — what collapsing leaves. */
  "panel-left": {
    d: ["M3.5 5.5h17v13h-17z", "M9.5 5.5v13"],
    faint: ["M5.5 9h2", "M5.5 12h2"],
  },
  plus: { d: ["M12 5.5v13", "M5.5 12h13"] },
  "more-horizontal": {
    d: [],
    dots: [
      [6, 12, 1.4],
      [12, 12, 1.4],
      [18, 12, 1.4],
    ],
  },
  /** A lens with a handle, tilted the way a hand holds one. */
  search: {
    d: [
      "M10.75 4.5a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5z",
      "M15.5 15.5 20 20",
    ],
  },
  /** A funnel: wide at the top, one drop leaving the bottom. */
  filter: { d: ["M4.5 5.5h15l-5.75 6.75v5.5l-3.5 2v-7.5z"] },
  list: {
    d: ["M9 6.5h11", "M9 12h11", "M9 17.5h11"],
    dots: [
      [5, 6.5, 1.1],
      [5, 12, 1.1],
      [5, 17.5, 1.1],
    ],
  },
  /** A bin whose lid is lifted a little, so it reads as open-able. */
  trash: {
    d: [
      "M5.5 7h13",
      "M9 7V5.2a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V7",
      "M7 7l.9 11.1a1.6 1.6 0 0 0 1.6 1.4h5a1.6 1.6 0 0 0 1.6-1.4L17 7",
    ],
    faint: ["M10.5 10v6", "M13.5 10v6"],
  },
  "check-square": { d: ["M4.5 5.5h15v13h-15z", "M8 12.2l2.8 2.8L16 9.5"] },
  /** Two points and the line between them — a thing handed on. */
  share: {
    d: ["M8.5 12 15 8.5", "M8.5 12 15 15.5"],
    dots: [
      [17, 7, 2.4],
      [17, 17, 2.4],
      [6, 12, 2.4],
    ],
  },
  /** The fallback. A grid says "something is here" and claims nothing more. */
  layout: {
    d: ["M4.5 4.5h6v6h-6z", "M13.5 4.5h6v6h-6z", "M4.5 13.5h6v6h-6z"],
    faint: ["M13.5 13.5h6v6h-6z"],
  },
  asterisk: { d: ["M12 5v14", "M6 8.5l12 7", "M18 8.5l-12 7"] },

  // --- Time ----------------------------------------------------------------
  clock: {
    d: ["M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z", "M12 8v4.3l3 1.8"],
  },
  /** A month: the block, the two pins, and the week rules. */
  calendar: {
    d: ["M4.5 6.5h15v13h-15z", "M8 4v4", "M16 4v4", "M4.5 10.5h15"],
    faint: ["M8 14h2.5", "M13.5 14H16", "M8 17h2.5", "M13.5 17H16"],
  },
  /** One day, circled — what a booking is. */
  "calendar-1": {
    d: [
      "M4.5 6.5h15v13h-15z",
      "M8 4v4",
      "M16 4v4",
      "M4.5 10.5h15",
      "M12 12.75a2.25 2.25 0 1 0 0 4.5 2.25 2.25 0 0 0 0-4.5z",
    ],
  },

  // --- People --------------------------------------------------------------
  user: {
    d: [
      "M12 4.75a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z",
      "M5 19.5c0-3.6 3.1-5.5 7-5.5s7 1.9 7 5.5",
    ],
  },
  /** A team: one in front, two behind. The People section of the business. */
  users: {
    d: [
      "M10 5.25a3.25 3.25 0 1 0 0 6.5 3.25 3.25 0 0 0 0-6.5z",
      "M3.5 19.5c0-3.3 2.9-5 6.5-5s6.5 1.7 6.5 5",
    ],
    faint: ["M16.5 6.2a2.8 2.8 0 0 1 0 5.6", "M18 14.9c1.6.7 2.5 2.1 2.5 4.6"],
  },
  /** A pass on a lanyard: who somebody is here, and what it lets them do. */
  "id-badge": {
    d: [
      "M7 4.5h10a1.5 1.5 0 0 1 1.5 1.5v13a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V6A1.5 1.5 0 0 1 7 4.5z",
      "M12 9.25a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
      "M8.75 17.5c0-1.7 1.5-2.5 3.25-2.5s3.25.8 3.25 2.5",
    ],
    faint: ["M10 4.5V3.5h4v1"],
  },
  /** A card with a face on it: one person, filed. */
  contact: {
    d: [
      "M3.5 5.5h17v13h-17z",
      "M9 10.75a1.9 1.9 0 1 0 0 3.8 1.9 1.9 0 0 0 0-3.8z",
      "M6 17c0-1.6 1.4-2.4 3-2.4s3 .8 3 2.4",
    ],
    faint: ["M14.5 10.5h3.5", "M14.5 13.5h3.5"],
  },
  /** The book of customers: a person, and the relationship drawn round them. */
  "contact-round": {
    d: [
      "M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z",
      "M12 8.75a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z",
      "M7.6 17.8c.5-2 2.2-3 4.4-3s3.9 1 4.4 3",
    ],
  },
  /**
   * A page with a tick: a deal agreed.
   *
   * It was two clasping hands, four times, and none of them survived being
   * drawn in line alone — at sixteen pixels every version read as a squiggle,
   * because a handshake is a shape made of mass and this set is made of
   * strokes. The section is where a deal gets agreed; the agreement says that
   * and stays legible on the rail, which is the only place it has to work.
   */
  handshake: {
    d: [
      "M6 3.5h8l4.5 4.5v12.5H6z",
      "M14 3.5V8h4.5",
      "M8.75 14.2l2.1 2.1 4.2-4.2",
    ],
  },
  /** A building with floors — a company rather than a person. */
  building: {
    d: [
      "M5.5 19.5V6.2a1.2 1.2 0 0 1 1.2-1.2h7.6a1.2 1.2 0 0 1 1.2 1.2v13.3",
      "M15.5 10.5h3a1 1 0 0 1 1 1v8",
      "M3.5 19.5h17",
    ],
    faint: [
      "M8.5 8.5h1.5",
      "M12 8.5h1.5",
      "M8.5 12h1.5",
      "M12 12h1.5",
      "M10 19.5v-3.5h2v3.5",
    ],
  },
  phone: {
    d: [
      "M6.2 4.8 9 4l2 4-2.2 1.6a10.5 10.5 0 0 0 5.6 5.6L16 13l4 2-.8 2.8a2 2 0 0 1-2.2 1.4C10.6 18.4 5.6 13.4 4.8 7a2 2 0 0 1 1.4-2.2z",
    ],
  },
  // --- Money ---------------------------------------------------------------
  /** A purse with a clasp: the Money section, not one document inside it. */
  wallet: {
    d: [
      "M4 8.5h14.5a1.5 1.5 0 0 1 1.5 1.5v7.5a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 17.5z",
      "M4 8.5V7a1.5 1.5 0 0 1 1.5-1.5h10.2a1.3 1.3 0 0 1 1.3 1.3v1.7",
    ],
    dots: [[16.5, 13.5, 1.2]],
  },
  /** A document with a torn foot — what a customer is handed. */
  receipt: {
    d: ["M6 3.5h12v17l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4z"],
    faint: ["M9 8h6", "M9 11.5h6", "M9 15h3.5"],
  },
  /** A card with its magnetic stripe. Taking money in person. */
  "credit-card": {
    d: ["M3.5 6.5h17v11h-17z", "M3.5 10.5h17"],
    faint: ["M6.5 14.5h3.5"],
  },
  /** A pillared hall: the authority a return is filed with. */
  landmark: {
    d: [
      "M3.5 9.5 12 4.5l8.5 5",
      "M3.5 19.5h17",
      "M6 12v5",
      "M10 12v5",
      "M14 12v5",
      "M18 12v5",
    ],
    faint: ["M4.5 12h15"],
  },
  /** Keys and a total line — a figure being worked out rather than read. */
  calculator: {
    d: ["M5.5 3.5h13v17h-13z", "M8 7h8"],
    faint: [
      "M8.5 11.5h.01",
      "M12 11.5h.01",
      "M15.5 11.5h.01",
      "M8.5 14.5h.01",
      "M12 14.5h.01",
      "M15.5 14.5h.01",
      "M8.5 17.5h7",
    ],
    dots: [
      [8.5, 11.5, 0.9],
      [12, 11.5, 0.9],
      [15.5, 11.5, 0.9],
      [8.5, 14.5, 0.9],
      [12, 14.5, 0.9],
    ],
  },
  /** Bars, shortest first: a report, read left to right. */
  chart: {
    d: ["M4.5 19.5h15", "M7.5 19.5v-5", "M12 19.5v-9", "M16.5 19.5v-13"],
  },
  /** A line that goes up, with the arrow that says so. */
  "trending-up": { d: ["M4 16.5 9.5 11l3.5 3.5L20 7.5", "M15 7.5h5v5"] },
  // --- Work ----------------------------------------------------------------
  /** A case with a handle: the part of the business where work happens. */
  briefcase: {
    d: [
      "M3.5 8.5h17v10h-17z",
      "M9 8.5V6.2a1.2 1.2 0 0 1 1.2-1.2h3.6a1.2 1.2 0 0 1 1.2 1.2v2.3",
    ],
    faint: ["M3.5 13h17", "M11 12.2h2v1.6h-2z"],
  },
  /** Crates stacked two on one: everything the business itself runs on. */
  boxes: {
    d: ["M4 13.5h6.5v6H4z", "M13.5 13.5H20v6h-6.5z", "M8.75 5.5h6.5v6h-6.5z"],
    faint: ["M6 16.5h2.5", "M15.5 16.5H18", "M10.75 8.5h2.5"],
  },
  /** A board with columns: work moving from one to the next. */
  kanban: {
    d: ["M3.5 4.5h17v15h-17z", "M9 4.5v15", "M15 4.5v15"],
    faint: [
      "M5 8h2.5",
      "M5 11h2.5",
      "M10.5 8h3",
      "M16.5 8h2.5",
      "M16.5 11h2.5",
    ],
  },
  /** A board on a clip: the list of what is offered. */
  clipboard: {
    d: [
      "M5.5 5.5h13v15h-13z",
      "M9 5.5V4.2a1.2 1.2 0 0 1 1.2-1.2h3.6a1.2 1.2 0 0 1 1.2 1.2v1.3",
    ],
    faint: ["M8.5 10.5h7", "M8.5 13.5h7", "M8.5 16.5h4"],
  },
  /** A parcel with its tape line — a thing that ships. */
  package: {
    d: ["M12 3.5 20 7.5v9L12 20.5 4 16.5v-9z", "M4 7.5l8 4 8-4", "M12 11.5v9"],
    faint: ["M8 5.5l8 4"],
  },
  /** A dial at a glance: how the business is doing this morning. */
  gauge: {
    d: ["M4 16.5a8 8 0 0 1 16 0", "M12 16.5 15.8 11"],
    faint: ["M5.5 12.2l1.6.9", "M12 7.5v1.8", "M18.5 12.2l-1.6.9"],
    dots: [[12, 16.7, 1.2]],
  },
  /** A bolt: something that happens without anybody doing it. */
  bolt: { d: ["M13.5 3.5 6 13.5h5l-.5 7 7.5-10h-5z"] },

  // --- Selling -------------------------------------------------------------
  /** A trolley: the shop, from the customer's side. */
  "shopping-cart": {
    d: ["M3.5 4.5h2.2l2.4 10.5h9.2l2.2-7.5H7"],
    dots: [
      [9.5, 19, 1.5],
      [17, 19, 1.5],
    ],
  },
  /** A carrier bag: one order rather than the whole shop. */
  "shopping-bag": {
    d: ["M5.5 7.5h13l-1 12h-11z", "M9 9.5V6.8a3 3 0 0 1 6 0v2.7"],
  },
  /** An awning over a door: the shop as a place. */
  store: {
    d: [
      "M4 9.5h16v10H4z",
      "M3 9.5 5 4.5h14l2 5",
      "M4 9.5a2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0",
    ],
    faint: ["M10 19.5v-5h4v5"],
  },
  /** A label with its hole: what a thing is called and what it costs. */
  tag: {
    d: [
      "M11.5 3.5H20v8.5l-8.6 8.6a1.5 1.5 0 0 1-2.1 0l-6.4-6.4a1.5 1.5 0 0 1 0-2.1z",
    ],
    dots: [[16.5, 7, 1.2]],
  },
  /** A ribboned box: something given rather than sold. */
  gift: {
    d: ["M3.5 8.5h17v4h-17z", "M5 12.5v7h14v-7", "M12 8.5v11"],
    faint: [
      "M12 8.5C10.5 5 8 4 7 5.2c-1 1.2.4 3.3 5 3.3",
      "M12 8.5c1.5-3.5 4-4.5 5-3.3 1 1.2-.4 3.3-5 3.3",
    ],
  },
  // --- Words -------------------------------------------------------------
  /** A page with a folded corner and lines on it. */
  "file-text": {
    d: ["M6 3.5h8l4.5 4.5v12.5H6z", "M14 3.5V8h4.5"],
    faint: ["M9 12h6", "M9 15h6", "M9 18h3.5"],
  },
  /** One page in front of another: a place things are kept. */
  files: {
    d: ["M8 6.5h6.5L18.5 10v9.5H8z", "M14.5 6.5V10h4"],
    faint: ["M5.5 17V4.5h6.5"],
  },
  /** An open book: the documentation, and the books. */
  "book-open": {
    d: [
      "M12 7.5C10.2 6 8.2 5.5 5 5.5v12c3.2 0 5.2.5 7 2 1.8-1.5 3.8-2 7-2v-12c-3.2 0-5.2.5-7 2z",
      "M12 7.5v12",
    ],
  },
  /** An envelope with its flap: mail that is sent, not a list. */
  mail: {
    d: ["M3.5 6.5h17v11h-17z", "M3.5 7.5 12 13l8.5-5.5"],
  },
  /** The at-sign: a mailing list is addresses, not envelopes. */
  "at-sign": {
    d: [
      "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z",
      "M15.5 8.5v4.2a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.4 6.8",
    ],
  },
  /** Two links of a chain, one handed to somebody else. */
  link: {
    d: [
      "M10.5 13.5a3.5 3.5 0 0 0 5 0l2.5-2.5a3.5 3.5 0 0 0-5-5l-1.2 1.2",
      "M13.5 10.5a3.5 3.5 0 0 0-5 0L6 13a3.5 3.5 0 0 0 5 5l1.2-1.2",
    ],
  },
  /** A page with a corner turned and a bell's clapper — something to read now. */
  notice: {
    d: ["M6 4.5h12v15H6z", "M12 8v4.5"],
    faint: ["M9 16h6"],
    dots: [[12, 15.2, 0.9]],
  },

  // --- Configuration -----------------------------------------------------
  /**
   * A cog, drawn as a cog.
   *
   * It was a circle with eight radiating ticks, which is how a gear is
   * usually abbreviated — and on the rail at twenty pixels it read as a sun.
   * The teeth have to be part of the outline for the shape to say "machine"
   * rather than "daylight".
   */
  settings: {
    d: [
      "M10.6 3.5h2.8l.35 2.2a6.6 6.6 0 0 1 1.75 1.02l2.05-.85 1.4 2.42-1.7 1.45a6.6 6.6 0 0 1 0 2.02l1.7 1.45-1.4 2.42-2.05-.85a6.6 6.6 0 0 1-1.75 1.02l-.35 2.2h-2.8l-.35-2.2a6.6 6.6 0 0 1-1.75-1.02l-2.05.85-1.4-2.42 1.7-1.45a6.6 6.6 0 0 1 0-2.02l-1.7-1.45 1.4-2.42 2.05.85a6.6 6.6 0 0 1 1.75-1.02z",
      "M12 9.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z",
    ],
  },
  /** Sliders: one screen's own settings rather than the whole section's. */
  sliders: {
    d: ["M4.5 7.5h15", "M4.5 12h15", "M4.5 16.5h15"],
    dots: [
      [9, 7.5, 1.7],
      [15, 12, 1.7],
      [7.5, 16.5, 1.7],
    ],
  },
  /** A key with its bit: who may open what. */
  key: {
    d: [
      "M14.5 5.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z",
      "M11 12.5 4 19.5",
      "M6.5 17l2 2",
      "M8.5 15l1.5 1.5",
    ],
    dots: [[14.5, 8.8, 1]],
  },
  /** A shield with the tick inside: checked, not merely guarded. */
  shield: {
    d: [
      "M12 3.5 19.5 6v6c0 4.5-3 7-7.5 8.5C7.5 19 4.5 16.5 4.5 12V6z",
      "M9 11.8l2.3 2.4L15.2 10",
    ],
  },
  /** A cycle that closes: billing that comes round again. */
  "refresh-cw": {
    d: ["M19.5 12a7.5 7.5 0 1 1-2.2-5.3", "M19.5 4.5V9h-4.5"],
  },
  /** Two arrows chasing: something repeated on a schedule. */
  repeat: {
    d: [
      "M5 9.5h11.5a2.5 2.5 0 0 1 2.5 2.5",
      "M7.5 7 5 9.5 7.5 12",
      "M19 14.5H7.5A2.5 2.5 0 0 1 5 12",
      "M16.5 17 19 14.5 16.5 12",
    ],
  },
};

/**
 * Names a module may ask for that mean the same thing as a drawn one.
 *
 * A module in another repository was built against whatever name it was
 * built against, and a picture is not worth breaking somebody's nav over.
 * Kept small and deliberate rather than growing into a synonym dictionary:
 * each line is a name that shipped before this set existed.
 */
const ALIASES: Record<string, string> = {
  shop: "shopping-cart",
  contacts: "contact-round",
  "calendar-days": "calendar",
  "id-card": "id-badge",
  icon: "layout",
  "check-circle": "check-square",
};

export type IconName = keyof typeof GLYPHS;

/**
 * An unknown name draws the fallback rather than throwing.
 *
 * A module built against a later host will ask for icons this one has never
 * heard of, and a missing picture must never be why a sidebar fails to
 * render. It is deliberately a plain grid: it should look like a thing
 * nobody drew, so it is noticed and fixed, not mistaken for a decision.
 */
export function Icon({
  name,
  size = 18,
}: {
  name: IconName | (string & {});
  size?: number;
}) {
  const fallback: Glyph = { d: ["M4.5 4.5h15v15h-15z"] };
  const glyph =
    GLYPHS[name] ?? GLYPHS[ALIASES[name] ?? ""] ?? GLYPHS.layout ?? fallback;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <title>{name}</title>
      {glyph.d.map((d) => (
        <path key={d} d={d} />
      ))}
      {glyph.faint?.map((d) => (
        <path key={d} d={d} opacity={0.5} />
      ))}
      {glyph.dots?.map(([cx, cy, r]) => (
        <circle
          key={`${cx}-${cy}`}
          cx={cx}
          cy={cy}
          r={r}
          fill="currentColor"
          stroke="none"
        />
      ))}
    </svg>
  );
}
