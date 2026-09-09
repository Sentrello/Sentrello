# Accessibility

Sentrello targets **WCAG 2.2 Level AA**. This page says what has been tested,
how, what the results were, and — the part most statements leave out — what has
**not** been tested.

Last assessed: **9 September 2026**, against every screen the application
offers.

## Why you may need this

| Where | What applies |
|---|---|
| European Union | European Accessibility Act, in force since 28 June 2025. It covers e-commerce, so a business selling online in the EU is in scope |
| EU public sector | EN 301 549, which points at WCAG |
| United Kingdom | Public Sector Bodies Accessibility Regulations; Equality Act duties more generally |
| United States | Section 508 for federal procurement; ADA Title III for commercial sites |
| Canada | Accessible Canada Act; AODA in Ontario requires WCAG 2.0 AA of private organisations with fifty or more staff |

If you are answering a procurement questionnaire, this page is the honest
version of what such a questionnaire asks for.

## What is tested, and how

Every screen the application offers is loaded in a real browser, signed in, and
checked with **axe-core** against WCAG 2.0, 2.1 and 2.2 at levels A and AA. It
runs with the rest of the test suite, so a change that breaks accessibility
fails before it is released rather than after somebody reports it.

**Issues at "serious" and "critical" severity fail the build.** The two lower
severities are reported and not enforced — they contain a large number of
contextual judgements, and a list nobody can clear becomes a check somebody
turns off.

As of the last assessment, **every screen passes**.

## What that does not cover, and it is a lot

Automated testing finds roughly a third of accessibility problems. It is
genuinely good at the mechanical ones — colour contrast, missing names on
controls, targets too small to hit — and it cannot see most of the rest.

**Not yet verified by hand:**

- **Screen reader use end to end.** That every screen can be *operated* by
  somebody using JAWS, NVDA or VoiceOver, rather than merely exposing correct
  names to a testing tool.
- **Keyboard-only journeys.** Individual controls are reachable; complete tasks
  — raise an invoice, take a booking, record a payment — have not been walked
  through without a mouse.
- **Focus order and focus visibility** through dialogs and multi-step forms.
- **Content authored by you.** Your product descriptions, your uploaded images,
  your document titles. The software cannot supply alt text for a photograph a
  business uploads.

We would rather say this than claim a level of conformance nobody has checked.
If you need a formal VPAT or a manual audit for a procurement process, ask —
what exists today is the automated coverage described above, and that is a
starting point rather than the finish.

## Known specifics

- The deals board scrolls horizontally and is reachable with the keyboard, but
  the columns themselves are not individually navigable by arrow key. Somebody
  using a keyboard can reach and scroll it; drag-and-drop between columns is
  mouse-only, and the same moves are available from each card's own menu.
- Colour is never the only thing carrying meaning, but this has been checked by
  reading the code rather than by testing with a simulator.

## Reporting a problem

Email **security@sentrello.com** — the same address as for security reports,
because it reaches a person quickly. Tell us the screen, what you were using,
and what happened. An accessibility barrier is treated as a defect, not a
feature request.
