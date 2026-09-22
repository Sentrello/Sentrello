/**
 * The platform's own icons, drawn clean.
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
 * **This file is the drawing; it is not what the application renders.**
 * `scripts/draw-icons.mjs` puts every path here through a wobble that makes
 * the line look drawn by hand — James's instruction on 21 September, against
 * a folder of samples — and writes `icon-paths.ts`, which is what `Icon`
 * imports. Edit the geometry here, run the script, commit both.
 *
 * Roughening what is already rough compounds, which is the whole reason the
 * two files exist: this one never changes under the script.
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
      "M5 8.5h14",
      "M10.5 8.5V7a1.5 1.5 0 0 1 3 0v1.5",
      "M6.5 8.5l1.2 10a1.5 1.5 0 0 0 1.5 1.3h5.6a1.5 1.5 0 0 0 1.5-1.3l1.2-10",
    ],
    faint: ["M10.5 11.5v5.5", "M13.5 11.5v5.5"],
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
  /**
   * The house, with the morning's figures standing inside it.
   *
   * The Dashboard used to borrow the dial, which every module's own overview
   * screen also borrows, so the one entry that means "the whole business"
   * looked like the nine that mean "this module". A roof says home; the bars
   * say what you came to look at.
   */
  home: {
    d: [
      "M3.9 10.9 12 4.8l8.1 6.1v8.1a1.1 1.1 0 0 1-1.1 1.1H5a1.1 1.1 0 0 1-1.1-1.1z",
      "M8.9 16.8v-2.6",
      "M12 16.8v-5",
      "M15.1 16.8v-3.7",
    ],
  },

  // --- Time ----------------------------------------------------------------
  clock: {
    d: ["M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z", "M12 8v4.3l3 1.8"],
  },
  /** A month: the block, the two pins, and the week rules. */
  calendar: {
    d: [
      "M3.5 7.5h17v12.5h-17z",
      "M6 8.5V5.75a2 2 0 0 1 4 0V8.5",
      "M14 8.5V5.75a2 2 0 0 1 4 0V8.5",
      "M3.5 11h17",
    ],
    dots: [
      [8, 13.75, 0.9],
      [12, 13.75, 0.9],
      [16, 13.75, 0.9],
      [8, 16.75, 0.9],
      [12, 16.75, 0.9],
      [16, 16.75, 0.9],
    ],
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
  /**
   * Two people, one standing behind the other. The People section.
   *
   * It was three heads for a day, copied from the sample, and three heads
   * inside eighteen pixels is a hedge. Two read as two; the one behind is
   * drawn whole rather than as the two arcs it used to be, because half a
   * person at this size reads as a smudge beside the first one's shoulder.
   */
  users: {
    d: [
      "M9.4 5.6a3.3 3.3 0 1 0 0 6.6 3.3 3.4 0 0 0 0-6.6z",
      "M3 19.6c0-3.4 2.9-5.2 6.4-5.2s6.4 1.8 6.4 5.2",
    ],
    faint: [
      "M16.2 5.9a2.7 2.7 0 1 0 0 5.4 2.7 2.7 0 0 0 0-5.4z",
      "M13.9 13.9c2.8-.3 7.1.9 7.1 5",
    ],
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
  /**
   * A customer card with its clip: the sample's mark, not a person in a circle.
   *
   * The old drawing was a head inside a hexagon, which is what a general-purpose
   * set offers for "contacts". What a CRM opens is the card index — one card per
   * customer, clipped, with what you know about them written down the side.
   */
  "contact-round": {
    d: [
      "M4.5 7h15a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z",
      "M7.6 7V5.4a1.7 1.7 0 0 1 3.4 0v3a1 1 0 0 1-2 0V6.4",
    ],
    faint: ["M12.5 11h6", "M12.5 13.5h6", "M12.5 16h3.5"],
  },
  /**
   * A line signed, and the pen still on it: the moment a deal stops being a
   * conversation.
   *
   * Eleven attempts at two clasped hands, and this is still the drawing that
   * ships. The record, because it is worth not repeating: strokes produced a
   * bird, a bone, a bowtie, an arrow, a bridge, a boat and three things with no
   * name, and a filled silhouette produced a shoe.
   *
   * The fault is not the hand drawing it. What identifies clasped hands is
   * overlapping mass with gaps between the fingers, and at eighteen pixels those
   * gaps are smaller than the line that would have to describe them. The
   * reference drawing solves it with two filled paths and about three and a half
   * thousand characters of curve, which is a different craft from this set and
   * probably a different person.
   *
   * So this draws the same event in a medium that survives the rail. It keeps
   * the name `handshake` because that is what every module asks for. If hands
   * are wanted, the honest route is a commissioned vector and a `filled` layer
   * on the Glyph type to carry it — about ten lines, and deliberately not left
   * in the tree unused.
   */
  handshake: {
    d: [
      "M4.6 18.6h14.8",
      "M6 15.1c1.4-3.2 2.9-3.2 3.5-1.2.6 1.7 1.7 1.9 2.7.4",
      "M13.6 15.9 18.4 11a1.3 1.3 0 0 0-1.8-1.8l-4.9 4.9-.5 2.3z",
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
      "M9 9.5C11 8.3 15.5 8.2 18 9.5C20.6 10.9 20.6 15.2 18.5 16.6C16 18 10 18 8 16.6C7 15.9 6.6 14.9 6.6 14H3.8V11H6.8C7.2 10.2 8 9.7 9 9.5Z",
      "M15.8 8.7L16.8 6L19 8.9",
      "M9 17.6V20",
      "M16.5 17.6V20",
      "M10.5 3.4A2 2 0 1 0 10.5 7.4A2 2 0 0 0 10.5 3.4Z",
    ],
    faint: ["M8.8 10.4H12.2", "M11.2 4.5A1.4 1.4 0 0 0 11.2 6.3"],
    dots: [[9.3, 12.2, 1]],
  },
  /**
   * A receipt with a torn foot and a currency mark on it.
   *
   * The tear is the identification — it is the one thing a till roll has that a
   * letter does not — so it is drawn big enough to survive the rail rather than
   * as a polite ripple. The printed lines sit left of the figure and stop short
   * of it: run underneath and they read as a smudge behind the mark.
   */
  receipt: {
    d: [
      "M5.5 4.5h13v15l-2.2-1.7-2.1 1.7-2.2-1.7-2.1 1.7-2.2-1.7-2.2 1.7z",
      "M15 9.1a2 2 0 0 0-1.7-.9c-1 0-1.8.6-1.8 1.3 0 1.8 3.5.9 3.5 2.7 0 .8-.8 1.4-1.8 1.4a2.1 2.1 0 0 1-1.8-1",
      "M13.3 7v8.4",
    ],
    faint: ["M7.6 8.4h2.2", "M7.6 11h2.2", "M7.6 13.6h2.2"],
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
      "M3.5 9h14v10h-14z",
      "M3.5 9 6.5 6h14v10l-3 3",
      "M17.5 9l3-3",
      "M9.5 6V4.75a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1V6",
    ],
    faint: ["M3.5 12.5h14"],
    dots: [[10.5, 12.5, 1.1]],
  },
  /**
   * Crates stacked two on one: everything the business itself runs on.
   *
   * The tape now runs the full width of each crate rather than sitting in
   * the middle of it as a stub. Three stubs at eighteen pixels read as
   * three dashes floating inside three squares; a line that meets both
   * edges reads as a lid.
   */
  boxes: {
    d: [
      "M3.6 12.8h7.3v6.8H3.6z",
      "M13.1 12.8h7.3v6.8h-7.3z",
      "M8.35 4.6h7.3v6.8h-7.3z",
    ],
    faint: ["M3.6 15.2h7.3", "M13.1 15.2h7.3", "M8.35 7h7.3"],
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
      "M8.5 5.5H5.5v15h13v-15h-3",
      "M8.5 7h7V4.75a1.25 1.25 0 0 0-1.25-1.25h-4.5A1.25 1.25 0 0 0 8.5 4.75z",
    ],
    faint: ["M8.5 11.5h7", "M8.5 15h4.5"],
    dots: [[12, 5.25, 0.9]],
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
  /**
   * A trolley: the shop, from the customer's side.
   *
   * The basket is its own closed shape now. It used to be one stroke that
   * ran from the handle round the basket and stopped, so at small sizes the
   * thing that read was a tick with two wheels under it.
   */
  "shopping-cart": {
    d: ["M3.4 4.8h2.2l1.1 3.7", "M6.7 8.5h13.9l-1.9 7.1H8.8z"],
    faint: ["M9.6 10.9h8.7"],
    dots: [
      [10.2, 18.8, 1.45],
      [17.2, 18.8, 1.45],
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
  /**
   * The till: a screen on a drawer, and the keys under your thumb.
   *
   * The POS borrowed the calculator, which is the same rectangle with the
   * same grid of dots and no drawer — so the one screen that takes money
   * over a counter looked like a tool for adding up.
   */
  till: {
    d: [
      "M3.7 12.4h16.6v7.3H3.7z",
      "M6.6 12.4V8.9a1.3 1.3 0 0 1 1.3-1.3h6.3a1.3 1.3 0 0 1 1.3 1.3v3.5",
    ],
    faint: ["M5.6 16.2h5.4", "M8.1 10.1h5.9"],
    dots: [
      [15.4, 15.3, 0.9],
      [17.6, 15.3, 0.9],
      [15.4, 17.6, 0.9],
      [17.6, 17.6, 0.9],
    ],
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
  /**
   * A filing cabinet with three drawers.
   *
   * Flat, after a version that hinted at a third dimension with a faint side
   * panel. Half opacity plus the wobble reads as a grey smear standing behind
   * the cabinet rather than as depth, which is a general lesson about this set:
   * the faint layer can carry detail *inside* a shape and cannot carry structure
   * outside one.
   *
   * The handles are full weight. Without them the drawers read as shelves, and a
   * shelf is not where a business keeps its insurance certificate.
   */
  files: {
    d: [
      "M4.5 5.5h15a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1z",
      "M3.5 9.9h17",
      "M3.5 14.3h17",
      "M10.1 7.7h3.8",
      "M10.1 12.1h3.8",
      "M10.1 16.5h3.8",
    ],
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
    d: ["M5 6.5h14l1.5 11h-17z", "M5 6.5 12 13.25 19 6.5"],
    faint: ["M3.5 17.5 9 12.5", "M20.5 17.5 15 12.5"],
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
      "M10.09 8.68 4.43 14.33A2.5 2.5 0 0 0 7.97 17.87L11.86 13.98",
      "M13.91 15.32 19.57 9.67A2.5 2.5 0 0 0 16.03 6.13L12.14 10.02",
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
      "M9.99 5.82 10.23 3.69h3.54l.24 2.13A6.5 6.5 0 0 1 16.35 7.17l1.97-.86 1.76 3.06-1.72 1.28A6.5 6.5 0 0 1 18.36 13.35l1.72 1.28-1.76 3.06-1.97-.86A6.5 6.5 0 0 1 14.01 18.18l-.24 2.13h-3.54l-.24-2.13A6.5 6.5 0 0 1 7.65 16.83l-1.97.86-1.76-3.06 1.72-1.28A6.5 6.5 0 0 1 5.64 10.65L3.92 9.37l1.76-3.06 1.97.86A6.5 6.5 0 0 1 9.99 5.82z",
      "M12 9.25a2.75 2.75 0 1 0 0 5.5 2.75 2.75 0 0 0 0-5.5z",
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
  /**
   * A currency mark inside two chasing arrows: the same sale, every month.
   *
   * Drawn at a generous radius on purpose. The first version used tight arcs and
   * the wobble that makes these look hand-drawn closed them up into a knot — at
   * 18px it read as a scribble with something trapped in it. A rough line needs
   * room to be rough in.
   */
  "refresh-cw": {
    d: [
      "M4.6 12A7.4 7.4 0 0 1 17 6.5",
      "M19.4 12A7.4 7.4 0 0 1 7 17.5",
      "M17.4 3.2v3.6h-3.6",
      "M6.6 20.8v-3.6h3.6",
      "M13.8 10.2a2.1 2.1 0 0 0-1.9-1c-1.1 0-2 .7-2 1.5 0 2 3.9 1.1 3.9 3.1 0 .8-.9 1.5-2 1.5a2.3 2.3 0 0 1-2-1",
      "M11.9 7.9v8.2",
    ],
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
