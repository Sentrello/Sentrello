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
  /** Dashboard: panels of unequal size, which is what a dashboard is. */
  layout: {
    d: [
      "M3.5 3.5h7v9h-7z",
      "M13.5 3.5h7v5h-7z",
      "M13.5 11.5h7v9h-7z",
      "M3.5 15.5h7v5h-7z",
    ],
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
  /** Booking: a calendar with two rings and the days it can offer. */
  "calendar-1": {
    d: [
      "M4 6.5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1z",
      "M3 11h18",
      "M8 7V3.6",
      "M16 7V3.6",
    ],
    dots: [
      [7.5, 14.4, 1.25],
      [12, 14.4, 1.25],
      [16.5, 14.4, 1.25],
      [7.5, 17.6, 1.25],
      [12, 17.6, 1.25],
    ],
  },

  // --- People --------------------------------------------------------------
  user: {
    d: [
      "M12 4.75a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z",
      "M5 19.5c0-3.6 3.1-5.5 7-5.5s7 1.9 7 5.5",
    ],
  },
  /** Users: a person, framed — an account rather than a crowd. */
  users: {
    d: [
      "M3.5 8V4.6a1 1 0 0 1 1-1H8",
      "M16 3.6h3.5a1 1 0 0 1 1 1V8",
      "M20.5 16v3.4a1 1 0 0 1-1 1H16",
      "M8 20.4H4.5a1 1 0 0 1-1-1V16",
      "M12 7.4a2.7 2.7 0 1 0 0 5.4 2.7 2.7 0 0 0 0-5.4z",
      "M7.6 18.4c.4-2.3 2.2-3.5 4.4-3.5s4 1.2 4.4 3.5",
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
  /** CRM: the customer card, with its clip. */
  "contact-round": {
    d: [
      "M3.5 6.6h17v11.4h-17z",
      "M7.4 6.6V4.9a1.6 1.6 0 0 1 3.2 0v3.4a.9.9 0 0 1-1.8 0V6.2",
      "M12.5 10.4h5.2",
      "M12.5 12.9h5.2",
      "M12.5 15.4h3.2",
    ],
  },
  /**
   * Sales: two people, and the number they are talking about.
   *
   * James's second reference, and it works where sixteen attempts at a
   * handshake did not — for a reason worth recording. A handshake is
   * overlapping mass, read entirely from the gaps between the fingers, and at
   * eighteen pixels those gaps are narrower than the line that would have to
   * describe them. This is two circles and a box: nothing overlaps, nothing is
   * inferred from a gap, and it survives being shrunk.
   *
   * Three things were wrong on the first cut, and they are the whole
   * difference. The tail is its own stroke rather than a notch cut into the
   * bubble's outline — drawn as one path it self-intersected and the bubble
   * rendered with a bite out of its side. The faces are wider than the bubble
   * is tall, because a face has three features inside it and the bubble has
   * one: at a stroke of 1.75 a four-unit circle has about two units of clear
   * interior, which is not enough room for eyes and a mouth that stay separate.
   * And they sit two units apart; closer, they merge into a single peanut —
   * the same fault that turned four knuckles into a moustache.
   *
   * Still called `handshake`, because that is the name every module already
   * asks for and a better picture is not worth breaking somebody's nav over.
   */
  handshake: {
    d: [
      "M6.3 0.6h11.4a1.4 1.4 0 0 1 1.4 1.4v7.6a1.4 1.4 0 0 1-1.4 1.4H6.3a1.4 1.4 0 0 1-1.4-1.4V2a1.4 1.4 0 0 1 1.4-1.4z",
      "M8.9 11 8.2 13.8l3.6-2.8",
      "M12 1.9v7.8",
      "M14 3.9a2.2 2.2 0 0 0-1.9-.9c-1.2 0-2.1.7-2.1 1.5 0 2.2 4 1 4 3.1 0 1-.9 1.6-2.1 1.6a2.3 2.3 0 0 1-1.9-.9",
      "M5.6 14.0a4.6 4.6 0 1 0 0 9.2 4.6 4.6 0 0 0 0 -9.2z",
      "M3.1 17.4c.4-.75 1.2-.75 1.6 0",
      "M6.5 17.4c.4-.75 1.2-.75 1.6 0",
      "M3.9 19.7c.95 1.05 2.45 1.05 3.4 0",
      "M18.4 14.0a4.6 4.6 0 1 0 0 9.2 4.6 4.6 0 0 0 0 -9.2z",
      "M15.9 17.4c.4-.75 1.2-.75 1.6 0",
      "M19.3 17.4c.4-.75 1.2-.75 1.6 0",
      "M16.7 19.7c.95 1.05 2.45 1.05 3.4 0",
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
  /**
   * Money: a note, with coins stacked beside it.
   *
   * Held well apart. The version before this overlapped them the way the
   * reference does, and where the reference has room to separate them with
   * shading, a stroke drawing at this size just merges the two into one blob.
   */
  wallet: {
    d: [
      "M2.6 9.8h11.8v7.4H2.6z",
      "M8.5 11.5a1.9 1.9 0 1 0 0 3.8 1.9 1.9 0 0 0 0-3.8z",
      "M4.6 9.8v7.4",
      "M12.4 9.8v7.4",
      "M18.6 6.2a2.8 1.5 0 1 0 0 3 2.8 1.5 0 0 0 0-3z",
      "M15.8 7.7v2.9c0 .8 1.3 1.5 2.8 1.5s2.8-.7 2.8-1.5V7.7",
      "M15.8 10.6v2.9c0 .8 1.3 1.5 2.8 1.5s2.8-.7 2.8-1.5v-2.9",
    ],
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
  /** SEO and Marketing: a signal found, and the line it is moving along. */
  chart: {
    d: [
      "M12.6 4.4a5.8 5.8 0 1 0 0 11.6 5.8 5.8 0 0 0 0-11.6z",
      "M9.4 12.2l2.2-2.6 1.9 1.5 2.7-3.6",
      "M7.6 15.1 4.3 19.4",
      "M17.6 15.1l3.3 4.3",
    ],
    dots: [
      [4.3, 19.4, 1.3],
      [20.9, 19.4, 1.3],
      [17.9, 6.1, 1.3],
    ],
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
  /** Projects: the job written down, and the pencil still on it. */
  kanban: {
    d: [
      "M4.5 3.5h9.5l3.5 3.4v7",
      "M4.5 3.5v17h6",
      "M13.8 3.6v3.4h3.6",
      "M7.4 8.6h2.4",
      "M7.4 12h2.4",
      "M7.4 15.4h2.4",
      "M11.4 9.8h2.6",
      "M11.4 13.2h1.4",
      "M13.6 19.9l5.6-5.6a1.5 1.5 0 0 1 2.1 2.1l-5.6 5.6-2.7.6z",
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
  /** Shop: a storefront with its awning out. */
  store: {
    d: [
      "M4 9.5h16v11H4z",
      "M3 9.5 5 5h14l2 4.5z",
      "M7.5 5 6.6 9.5",
      "M12 5v4.5",
      "M16.5 5l.9 4.5",
      "M6.5 12.5h4.5v4.5H6.5z",
      "M14.5 20.5v-3.4a1.8 1.8 0 0 1 3.6 0v3.4",
    ],
  },
  /**
   * POS: a register on a counter, with somebody behind it.
   *
   * The person is a head and two shoulders and nothing more. Two earlier
   * versions drew an arm reaching for the keys and both read, at eighteen
   * pixels, as somebody lying on a slab — detail below the size it survives at
   * is worse than no detail, because the eye still tries to resolve it.
   */
  till: {
    d: [
      "M3.5 14.2h11.2v6.3H3.5z",
      "M5.6 14.2v-3.4h7v3.4",
      "M7.2 12.4h3.8",
      "M6 17.4h6.2",
      "M18.2 4.4a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
      "M15 13.6a3.2 3.2 0 0 1 6.4 0v6.9H15z",
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
  /** Documentation: the manual, with code on the front. */
  "book-open": {
    d: [
      "M5.5 3.6h13v16.8h-13z",
      "M8.8 3.6v16.8",
      "M13.5 8.9 11.9 10.6l1.6 1.7",
      "M15.8 8.9l1.6 1.7-1.6 1.7",
      "M11.6 15.4h5.8",
    ],
  },
  /** An envelope with its flap: mail that is sent, not a list. */
  mail: {
    d: ["M5 6.5h14l1.5 11h-17z", "M5 6.5 12 13.25 19 6.5"],
    faint: ["M3.5 17.5 9 12.5", "M20.5 17.5 15 12.5"],
  },
  /** Newsletter: the mailbox, flag up. */
  "at-sign": {
    d: [
      "M3.6 16.6V11a4.4 4.4 0 0 1 4.4-4.4h8.4a4.4 4.4 0 0 1 4.4 4.4v5.6z",
      "M8 6.6V16.6",
      "M8 16.6v4",
      "M17.8 6.6V3.4h3.2",
      "M21 3.4v2.6h-3.2",
    ],
  },
  /** Links: what became of the people who followed them, plotted. */
  link: {
    d: ["M4.5 3.5v16.5h16", "M7 15.4l3.1-3.6 3 2 4.6-6"],
    dots: [
      [7, 15.4, 1.35],
      [10.1, 11.8, 1.35],
      [13.1, 13.8, 1.35],
      [17.7, 7.8, 1.35],
    ],
  },
  /** Helpdesk: a person wearing a headset, which is the whole idea. */
  notice: {
    d: [
      "M12 5.2a5.4 5.4 0 0 0-5.4 5.4v2.6",
      "M12 5.2a5.4 5.4 0 0 1 5.4 5.4v2.6",
      "M5 11.6h1.6v4H5a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1z",
      "M19 11.6h-1.6v4H19a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1z",
      "M17.4 15.6v1.6a2 2 0 0 1-2 2h-2",
      "M9.8 11.4a3 3 0 0 0 4.4 0",
    ],
    dots: [
      [9.9, 9.2, 0.9],
      [14.1, 9.2, 0.9],
    ],
  },

  // --- Configuration -----------------------------------------------------
  /** Configuration: two gears, both at full weight. */
  settings: {
    d: [
      "M15.6 13.4L13.4 15.0L13.8 17.8L11.0 17.4L9.4 19.6L7.8 17.4L5.0 17.8L5.4 15.0L3.2 13.4L5.4 11.8L5.0 9.0L7.8 9.4L9.4 7.2L11.0 9.4L13.8 9.0L13.4 11.8Z",
      "M9.4 11.1a2.3 2.3 0 1 0 0 4.6 2.3 2.3 0 0 0 0-4.6z",
      "M21.5 7.4L19.9 8.7L19.9 10.8L17.9 10.3L16.2 11.6L15.3 9.7L13.3 9.3L14.2 7.4L13.3 5.5L15.3 5.1L16.2 3.2L17.9 4.5L19.9 4.0L19.9 6.1Z",
      "M17.2 5.9a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z",
    ],
  },
  /** Settings: three vertical controls, each set somewhere different. */
  sliders: {
    d: [
      "M6 3.5v5.2",
      "M6 13.2v7.3",
      "M12 3.5v9.4",
      "M12 17.4v3.1",
      "M18 3.5v3.1",
      "M18 11.1v9.4",
      "M6 8.7a2.25 2.25 0 1 0 0 4.5 2.25 2.25 0 0 0 0-4.5z",
      "M12 12.9a2.25 2.25 0 1 0 0 4.5 2.25 2.25 0 0 0 0-4.5z",
      "M18 6.6a2.25 2.25 0 1 0 0 4.5 2.25 2.25 0 0 0 0-4.5z",
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
   * Subscriptions: the same thing, coming round again.
   *
   * Two clean arcs with proper arrowheads, and a diamond small enough to sit
   * inside them without touching. The version before this overlapped all three
   * shapes the way the reference does, and at eighteen pixels they fused into
   * one object that read as a wrapped sweet.
   */
  "refresh-cw": {
    d: [
      "M11.99 9.6 14.4 12l-2.41 2.4L9.6 12z",
      "M4.8 12a7.2 7.2 0 0 1 7.2-7.2c2.3 0 4.4 1.1 5.7 2.8",
      "M19.2 12a7.2 7.2 0 0 1-7.2 7.2c-2.3 0-4.4-1.1-5.7-2.8",
      "M17.7 3.9v3.7H14",
      "M6.3 20.1v-3.7H10",
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
