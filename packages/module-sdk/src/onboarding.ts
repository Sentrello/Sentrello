/**
 * What a module needs somebody to do before it is any use.
 *
 * A module arrives switched on and empty. The Shop with no products, the
 * Newsletter with no list, Booking with no availability — each is a screen that
 * works perfectly and shows nothing, and the person looking at it has to guess
 * which of six screens to open first. That guess is where a trial is lost.
 *
 * So a module says what its first few steps are, and the host draws a checklist
 * of whatever this instance loaded. **A checklist rather than a guided tour**,
 * because a tour has to be finished in one sitting and interrupts the thing
 * somebody actually came to do, while a list survives a reload, a week off, and
 * being read in a different order.
 *
 * **Done is derived, never stored.** A step knows how to ask whether it has
 * already happened — are there any products, is a payment provider connected —
 * rather than being ticked off and remembered. Three things fall out of that,
 * and they are the whole reason for the design:
 *
 * - A module added on day 200 to a business that has been running for months
 *   shows the steps it has already satisfied as already done. Nothing has to
 *   know when the module arrived.
 * - Undoing something brings its step back, which is honest: a business that
 *   deletes its last product has no catalogue, whatever a stored flag says.
 * - There is no state to migrate, reset, or get out of step with the data.
 *
 * The same shape as `registerSummary` and `registerPersonalData`, and for the
 * same reason: Core cannot name the modules in other repositories, so each one
 * says what it needs and Core runs whatever this instance loaded.
 */

export interface OnboardingStep {
  /** Unique within the guide. */
  id: string;
  /** What to do, as an instruction rather than a noun. */
  label: string;
  /** Why it matters, when that is not obvious from the label. */
  detail?: string;
  /** The nav entry this step's screen is, so the list can open it. */
  opens?: string;
  /**
   * Whether this has already happened.
   *
   * Asked of the data, every time the list is drawn. A step that cannot answer
   * — because it is advice rather than a thing with a row behind it — leaves
   * this off and is never shown as done.
   */
  done?: (organizationId: string) => Promise<boolean>;
}

export interface OnboardingGuide {
  /** Unique across modules; the module id is a good prefix. */
  id: string;
  /** What is being set up, in the words the rail uses. */
  label: string;
  icon?: string;
  /**
   * What a reader needs before they are shown this at all.
   *
   * Setting a module up is an administrator's job. Somebody who cannot do the
   * steps should not be handed a list of them — it is a list of things they
   * will be refused.
   */
  requires?: Record<string, string[]>;
  steps: OnboardingStep[];
}

export interface RegisteredGuide extends OnboardingGuide {
  moduleId: string;
}

/**
 * Module scope, not a class.
 *
 * Every module resolves `@sentrello/module-sdk` to the host's copy — it is a
 * peer dependency in each of them precisely so that there is one — so this
 * array is the same array for all of them. The host clears it before loading,
 * because the boot tests load modules more than once in one process.
 */
const registry: RegisteredGuide[] = [];

export function addOnboarding(guide: RegisteredGuide): void {
  const at = registry.findIndex((g) => g.id === guide.id);
  if (at >= 0) registry[at] = guide;
  else registry.push(guide);
}

export function allOnboarding(): RegisteredGuide[] {
  return [...registry];
}

/** For tests and for a host that loads its modules more than once. */
export function clearOnboarding(): void {
  registry.length = 0;
}

/**
 * One guide, with every step asked whether it has happened.
 *
 * A step that throws is reported as not done rather than taking the list with
 * it. A module that cannot count its own products is a module with a bug, and
 * the right answer is a step that stays on the list — not an onboarding screen
 * that fails to load for every other module too.
 */
export async function resolveGuide(
  guide: RegisteredGuide,
  organizationId: string,
): Promise<{
  id: string;
  moduleId: string;
  label: string;
  icon: string | null;
  steps: {
    id: string;
    label: string;
    detail: string | null;
    opens: string | null;
    done: boolean;
  }[];
  remaining: number;
}> {
  const steps = await Promise.all(
    guide.steps.map(async (step) => ({
      id: step.id,
      label: step.label,
      detail: step.detail ?? null,
      opens: step.opens ?? null,
      done: step.done
        ? await step.done(organizationId).catch(() => false)
        : false,
    })),
  );

  return {
    id: guide.id,
    moduleId: guide.moduleId,
    label: guide.label,
    icon: guide.icon ?? null,
    steps,
    remaining: steps.filter((s) => !s.done).length,
  };
}
