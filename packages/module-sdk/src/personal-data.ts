/**
 * What each module holds about a person, and what it can do about it.
 *
 * A data subject asks one question — "what do you have on me", "delete me" —
 * and every module has to answer it. Answering per module does not make a
 * platform compliant: the person does not know the Shop module from the CRM,
 * and a business that has to remember to visit six screens will miss one.
 *
 * The same shape as `registerSummary`, and for the same reason: Core cannot
 * name Shop or Booking, which live in another repository, so each module says
 * what it holds and Core runs whatever is registered on this instance.
 *
 * The rights this exists to serve are the ones with deadlines attached — GDPR
 * articles 15, 16, 17 and 20, and the CCPA rights to know, delete and opt out.
 * A module that answers slowly is a business that answers late.
 */

/** A person, named the ways a business actually knows them. */
export interface DataSubject {
  email?: string;
  phone?: string;
  /** An IP address, for the modules whose records are of visits. */
  address?: string;
  /** A contact, customer or user id, when the caller already has one. */
  id?: string;
}

/** One record a module holds about the subject. */
export interface PersonalRecord {
  /** What this is, in the words a person would use: "Order", "Invoice". */
  kind: string;
  /** Enough to recognise it: an order number, an invoice number, a date. */
  reference?: string;
  /** The data itself, already free of anything belonging to somebody else. */
  data: Record<string, unknown>;
}

export interface EraseOutcome {
  /** What was removed or anonymised, in a sentence a business can repeat. */
  removed: string[];
  /**
   * What was kept, and under which lawful basis.
   *
   * **Never empty for a module that keeps anything.** An invoice cannot be
   * deleted because tax law requires it to exist, and a business that tells a
   * customer "everything is gone" while the ledger still names them has made a
   * false statement. Saying so plainly is the compliant answer, not a failure.
   */
  kept: { what: string; why: string }[];
}

export interface PersonalDataSource {
  /** Unique across modules; the module id is a good prefix. */
  id: string;
  /** What a person would call this store: "Customer records", "Orders". */
  label: string;
  /**
   * Everything held about the subject, for an access or portability request.
   *
   * Return an empty array when nothing is held — that is an answer, and a
   * business needs to be able to say it.
   */
  export: (
    organizationId: string,
    subject: DataSubject,
  ) => Promise<PersonalRecord[]>;
  /**
   * Erase or anonymise, and say what happened.
   *
   * Absent where a module holds nothing it may lawfully delete. Omitting this
   * is a statement — "there is nothing here to erase" — and is better than an
   * implementation that quietly does nothing.
   */
  erase?: (
    organizationId: string,
    subject: DataSubject,
  ) => Promise<EraseOutcome>;
  /**
   * How long this module keeps what it holds, in words.
   *
   * Required, because a record of processing that cannot say how long data is
   * kept is not a record of processing. "Until the customer is deleted" is a
   * valid answer; silence is not.
   */
  retention: string;
}

export interface RegisteredPersonalData extends PersonalDataSource {
  moduleId: string;
}

const sources: RegisteredPersonalData[] = [];

export function addPersonalData(source: RegisteredPersonalData): void {
  const at = sources.findIndex((s) => s.id === source.id);
  // Replaced rather than appended, so a module registered twice — which happens
  // in tests that boot the app more than once — does not answer twice and make
  // an export list every record double.
  if (at >= 0) sources[at] = source;
  else sources.push(source);
}

export function personalDataSources(): RegisteredPersonalData[] {
  return [...sources];
}

/** For tests that need the registry empty before they start. */
export function clearPersonalData(): void {
  sources.length = 0;
}
