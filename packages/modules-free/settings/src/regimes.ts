/**
 * Compliance as a set of things you switch on, like modules.
 *
 * A t-shirt shop in Texas and the same shop in Berlin are the same software
 * and not the same obligations. Building one fixed idea of "compliant" would
 * mean either imposing European paperwork on a business that has none, or
 * shipping a European business something that does not meet its law. Both are
 * wrong, and the first is the one a vendor does by accident when it wants a
 * tidy feature list.
 *
 * So a business says where it operates and what it does, and the platform turns
 * on what follows. Chosen during setup, changed whenever the business changes —
 * an American shop that starts selling into the EU, a builder who takes on NHS
 * work, a practice that stops handling health records. Nothing here is a
 * one-way door.
 *
 * **What is deliberately not a regime.** The things that cost a business
 * nothing and are right everywhere are simply on: an audit log, TLS, org
 * scoping, cards never touching the server. A switch for those would be a
 * switch somebody turns off.
 */

export interface Regime {
  id: string;
  label: string;
  /** Where this applies, in the words the business would use. */
  where: string;
  /** Why it applies to them — the sentence that helps them decide. */
  when: string;
  /**
   * What the platform does differently, in plain terms.
   *
   * Empty where a regime turns nothing on, which is honest and matters: the
   * subject-access tools work whether or not GDPR is selected, because a
   * business that is asked a question should be able to answer it either way.
   * What the regime changes is the guidance and the obligations shown.
   */
  turnsOn: string[];
  /** What the business must do that no software can do for them. */
  yourJob: { what: string; why: string }[];
  /** Suggested when the business says it operates here. */
  suggestedFor?: { places?: string[]; sectors?: string[] };
}

export const REGIMES: Regime[] = [
  {
    id: "uk-eu-gdpr",
    label: "UK and EU data protection (GDPR)",
    where: "The UK, the EU, or selling to people who live there",
    when: "You hold the name, email or address of anybody in the UK or EU — including one customer.",
    turnsOn: [
      "A month's deadline shown on subject requests",
      "Retention periods stated on every store of personal data",
      "The record of processing an authority can ask for",
    ],
    yourJob: [
      {
        what: "A privacy notice saying what you collect and why",
        why: "Required before you collect anything, and the first thing an authority asks to see.",
      },
      {
        what: "A lawful basis for each thing you do with personal data",
        why: "Consent is one of six and usually the wrong one for running a business.",
      },
    ],
    suggestedFor: { places: ["uk", "eu"] },
  },
  {
    id: "ccpa",
    label: "California (CCPA/CPRA)",
    where: "California",
    when: "You sell to Californians and are over the revenue or volume thresholds. Many small businesses are not — check before switching this on.",
    turnsOn: [
      "Forty-five days shown on subject requests, rather than a month",
      "A do-not-sell-or-share choice recorded against a contact",
    ],
    yourJob: [
      {
        what: "A 'Do Not Sell or Share My Personal Information' link on your website",
        why: "Required to be on the page itself, not only in a policy.",
      },
    ],
    suggestedFor: { places: ["us-ca"] },
  },
  {
    id: "hipaa",
    label: "US health information (HIPAA)",
    where: "The United States",
    when: "You are a healthcare provider, health plan, or handle patient information for one. A gym or a wellness coach usually is not.",
    turnsOn: [
      "Automatic sign-out after a set time",
      "A second factor required from everybody",
      "Every read of a patient's record recorded, not only changes",
    ],
    yourJob: [
      {
        what: "A written risk assessment",
        why: "§164.308(a)(1)(ii)(A). The commonest finding is that nobody can produce one.",
      },
      {
        what: "Business Associate Agreements with anybody who can see the data",
        why: "Your host, your backups, your email relay. Not us — you run this yourself and we never see it.",
      },
      {
        what: "Workforce training, with a record of who had it",
        why: "The control that fails is a person, not a server.",
      },
      {
        what: "A breach notification plan",
        why: "Sixty days, starting when somebody discovers it.",
      },
      {
        what: "Encryption at rest on this server and its backups",
        why: "This application cannot see the disk it runs on.",
      },
    ],
    suggestedFor: { places: ["us"], sectors: ["health"] },
  },
  {
    id: "pipeda",
    label: "Canadian privacy (PIPEDA, Quebec Law 25)",
    where: "Canada",
    when: "You hold personal information about anybody in Canada. Quebec adds its own rules on top.",
    turnsOn: [
      "Consent records kept with the personal data they cover",
      "Retention periods stated, as PIPEDA's limiting principle requires",
    ],
    yourJob: [
      {
        what: "Name a privacy officer",
        why: "PIPEDA requires somebody accountable, by name.",
      },
      {
        what: "A privacy impact assessment, if you are in Quebec",
        why: "Law 25 requires one before a project involving personal information.",
      },
    ],
    suggestedFor: { places: ["ca"] },
  },
  {
    id: "accessibility",
    label: "Accessibility (WCAG 2.2 AA)",
    where: "Everywhere, and required by law in most of it",
    when: "You sell online in the EU, work with any government, are in Ontario with fifty staff, or would rather not be sued in the United States.",
    turnsOn: [
      "Accessibility checked on every screen when the platform is tested",
      "A conformance report you can hand to a procurement team",
    ],
    yourJob: [
      {
        what: "Any content you write — alt text on your own images, plain language",
        why: "We can make the software accessible. We cannot write your product descriptions.",
      },
    ],
    suggestedFor: { places: ["eu", "uk", "ca", "us"], sectors: ["government"] },
  },
  {
    id: "soc2",
    label: "Security audits (SOC 2, ISO 27001)",
    where: "Anywhere you sell to larger businesses",
    when: "A customer has sent you a security questionnaire, or you are going through an audit.",
    turnsOn: [
      "An evidence pack: who has access, every change to it, what data is held",
    ],
    yourJob: [
      {
        what: "The controls themselves, and evidence you operate them",
        why: "An auditor examines your organisation. The software can only produce the facts.",
      },
    ],
    suggestedFor: { sectors: ["government", "enterprise"] },
  },
];

/**
 * What to suggest when a business says where it is and what it does.
 *
 * Suggested, never imposed. A business knows things this cannot: whether it is
 * over the CCPA thresholds, whether it is a covered entity, whether the one
 * German customer it has makes it worth the paperwork. The screen offers and
 * the business decides.
 */
export function suggestedRegimes(input: {
  places?: string[];
  sectors?: string[];
}): string[] {
  const places = new Set(input.places ?? []);
  const sectors = new Set(input.sectors ?? []);
  return REGIMES.filter((r) => {
    const p = r.suggestedFor?.places?.some((x) => places.has(x)) ?? false;
    const s = r.suggestedFor?.sectors?.some((x) => sectors.has(x)) ?? false;
    return p || s;
  }).map((r) => r.id);
}
