import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { type Contact, type LabelledValue, api } from "../lib/api";
import {
  type CrmSettings,
  managerName,
  useCrmManagers,
} from "../lib/crm-settings";
import { CustomFields } from "../lib/custom-fields";
import { Icon } from "../lib/icons";
import { RecordPicker } from "../lib/record-picker";
import {
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  Page,
  Select,
  Textarea,
  Toolbar,
  border,
  muted,
} from "../lib/ui";

/**
 * Creating and editing a contact, with every field the record actually has.
 *
 * One form for both, because "add a contact" and "edit a contact" asking for
 * different things is how a CRM ends up with records that can only be
 * completed in two passes. The specific complaint this fixes: a second email
 * address could only be added *after* the contact existed, so anybody
 * entering somebody with a work and a personal address had to save, reopen
 * and edit.
 *
 * Laid out in the four groups the reference uses — identity, position, the ways
 * to reach them, and everything that is not a field — because that order is
 * the order somebody reads a business card in.
 */

const CONTACT_LABELS = ["Work", "Home", "Other"];

/** A list of labelled emails or phone numbers, added to and removed from. */
function LabelledList({
  legend,
  values,
  onChange,
  type,
  placeholder,
}: {
  legend: string;
  values: LabelledValue[];
  onChange: (next: LabelledValue[]) => void;
  type: "email" | "tel";
  placeholder: string;
}) {
  const update = (i: number, patch: Partial<LabelledValue>) =>
    onChange(values.map((v, at) => (at === i ? { ...v, ...patch } : v)));

  return (
    <fieldset className="flex flex-col gap-(--gap-toolbar)">
      <legend className="mb-(--gap-tight) block text-sm">{legend}</legend>
      {values.map((entry, i) => (
        // The index is the identity here: these rows have no id of their own
        // until they are saved, and two blank rows are legitimately equal.
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id before saving
        <div key={i} className="flex gap-(--gap-toolbar)">
          <Input
            type={type}
            value={entry.value}
            placeholder={placeholder}
            onChange={(e) => update(i, { value: e.target.value })}
          />
          <Select
            value={entry.label}
            aria-label={`${legend} type`}
            className="w-28"
            onChange={(e) => update(i, { label: e.target.value })}
          >
            {CONTACT_LABELS.map((label) => (
              <option key={label} value={label}>
                {label}
              </option>
            ))}
          </Select>
          <button
            type="button"
            className="link-muted px-1"
            aria-label={`Remove this ${legend.toLowerCase()}`}
            onClick={() => onChange(values.filter((_, at) => at !== i))}
            // The first row is the one the rest of the product reads as "the"
            // email, so it stays. Emptying it is how you clear it.
            disabled={values.length === 1}
          >
            <Icon name="close" size={15} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="text-sm link"
        onClick={() => onChange([...values, { label: "Work", value: "" }])}
      >
        Add another
      </button>
    </fieldset>
  );
}

/**
 * The stored lists, as the form wants them.
 *
 * The first email and phone are plain columns because invoicing and the
 * customer portal read them directly; the rest live in a list. The form
 * shows one continuous list and splits it again on save, so nobody has to
 * know that the first one is special.
 */
function toList(
  first: string | null,
  rest: LabelledValue[] | null,
): LabelledValue[] {
  const all = [
    ...(first ? [{ label: "Work", value: first }] : []),
    ...(rest ?? []),
  ];
  return all.length ? all : [{ label: "Work", value: "" }];
}

function fromList(list: LabelledValue[]): {
  first: string | null;
  rest: LabelledValue[];
} {
  const filled = list.filter((entry) => entry.value.trim());
  const [head, ...tail] = filled;
  return { first: head?.value.trim() ?? null, rest: tail };
}

/**
 * The two name boxes, filled from whatever the record actually has.
 *
 * `firstName` and `lastName` are not always set. A contact can arrive from a
 * website form, an import or an API call carrying only `name`, and this form
 * used to open with both boxes empty for every one of them — which looked like
 * lost data and, because Save is disabled until one of them has something in
 * it, meant those contacts could never be edited at all. Six of the eighteen
 * on the demo were in that state.
 *
 * So the stored display name is the fallback, split on the first space the way
 * the CRM splits an enquiry's name. Exported to be tested: this is the kind of
 * thing that silently regresses.
 */
export function nameBoxes(contact?: {
  firstName: string | null;
  lastName: string | null;
  name?: string | null;
}): { firstName: string; lastName: string } {
  if (!contact) return { firstName: "", lastName: "" };
  if (contact.firstName || contact.lastName) {
    return {
      firstName: contact.firstName ?? "",
      lastName: contact.lastName ?? "",
    };
  }
  const parts = (contact.name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  const [first, ...rest] = parts;
  return { firstName: first ?? "", lastName: rest.join(" ") };
}

export function ContactForm({
  contact,
  settings,
  onDone,
}: {
  /** Absent when creating. */
  contact?: Contact;
  settings: CrmSettings;
  onDone: (saved?: Contact) => void;
}) {
  const boxes = nameBoxes(contact);
  const [firstName, setFirstName] = useState(boxes.firstName);
  const [lastName, setLastName] = useState(boxes.lastName);
  const [title, setTitle] = useState(contact?.title ?? "");
  /**
   * Where they work, chosen by searching.
   *
   * Two screens used to hand this form the whole companies list to fill a
   * `<select>`, and `/api/companies` stops at a thousand rows — so at a
   * larger business the right company was simply not among the options, and
   * the contact was saved attached to nobody or to whoever was nearest.
   */
  const [company, setCompany] = useState<{ id: string; name: string } | null>(
    contact?.companyId
      ? { id: contact.companyId, name: contact.companyName ?? "" }
      : null,
  );
  const companyId = company?.id ?? "";
  const [status, setStatus] = useState(
    contact?.status ?? settings.contactStatuses[0]?.id ?? "cold",
  );
  const [background, setBackground] = useState(contact?.background ?? "");
  const [linkedinUrl, setLinkedinUrl] = useState(contact?.linkedinUrl ?? "");
  const [gender, setGender] = useState(contact?.gender ?? "");
  const [ownerId, setOwnerId] = useState(contact?.ownerId ?? "");
  const managers = useCrmManagers();
  const [hasNewsletter, setHasNewsletter] = useState(
    contact?.hasNewsletter ?? false,
  );
  /**
   * The CCPA right to opt out of a business selling or sharing your data.
   *
   * Deliberately not the same control as the newsletter tick above it, and the
   * distinction is the one businesses get wrong: unsubscribing is about being
   * *contacted*, this is about the data going elsewhere. Somebody can be happy
   * to hear from you monthly and object to being on a list you hand to an
   * agency, and treating the two as one control loses one of them.
   */
  const [doNotSell, setDoNotSell] = useState(contact?.doNotSell ?? false);
  const [customValues, setCustomValues] = useState<
    Record<string, string | number | boolean | null>
  >(contact?.customValues ?? {});
  const [emails, setEmails] = useState<LabelledValue[]>(
    toList(contact?.email ?? null, contact?.emails ?? null),
  );
  const [phones, setPhones] = useState<LabelledValue[]>(
    toList(contact?.phone ?? null, contact?.phones ?? null),
  );

  const save = useMutation({
    mutationFn: async () => {
      const email = fromList(emails);
      const phone = fromList(phones);
      const body = {
        firstName: firstName.trim() || null,
        lastName: lastName.trim() || null,
        title: title.trim() || null,
        companyId: companyId || null,
        status,
        background: background.trim() || null,
        linkedinUrl: linkedinUrl.trim() || null,
        gender: gender || null,
        ownerId: ownerId || null,
        hasNewsletter,
        doNotSell,
        email: email.first,
        emails: email.rest,
        phone: phone.first,
        phones: phone.rest,
        customValues,
      };
      const res = await api<{ contact: Contact }>(
        contact ? `/api/contacts/${contact.id}` : "/api/contacts",
        {
          method: contact ? "PATCH" : "POST",
          body: JSON.stringify(body),
        },
      );
      return res.contact;
    },
    onSuccess: (saved) => onDone(saved),
  });

  const named = firstName.trim() || lastName.trim();

  return (
    <Page width="prose">
      <Card>
        <form
          className="flex flex-col gap-(--gap-stack)"
          onSubmit={(e) => {
            e.preventDefault();
            if (named) save.mutate();
          }}
        >
          <div className="grid gap-(--gap-toolbar) sm:grid-cols-2">
            <Field label="First name">
              <Input
                value={firstName}
                autoFocus
                onChange={(e) => setFirstName(e.target.value)}
              />
            </Field>
            <Field label="Last name">
              <Input
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
              />
            </Field>
          </div>

          <div className="grid gap-(--gap-toolbar) sm:grid-cols-2">
            <Field label="Job title">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
            <Field label="Company">
              <RecordPicker
                path="/api/companies"
                resource="companies"
                value={company}
                onChange={setCompany}
                placeholder="Search companies"
                clearLabel="No company"
                noun="company"
              />
            </Field>
          </div>

          <div
            className="grid gap-(--gap-stack) border-t pt-(--gap-stack) sm:grid-cols-2"
            style={border}
          >
            <LabelledList
              legend="Email"
              values={emails}
              onChange={setEmails}
              type="email"
              placeholder="name@example.com"
            />
            <LabelledList
              legend="Phone"
              values={phones}
              onChange={setPhones}
              type="tel"
              placeholder="+1 555 0100"
            />
          </div>

          <div
            className="grid gap-(--gap-toolbar) border-t pt-(--gap-stack) sm:grid-cols-2"
            style={border}
          >
            <Field label="Status">
              <Select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                {settings.contactStatuses.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="LinkedIn">
              <Input
                value={linkedinUrl}
                placeholder="https://linkedin.com/in/…"
                onChange={(e) => setLinkedinUrl(e.target.value)}
              />
            </Field>
            <Field label="Account manager" hint="Whose contact this is.">
              <Select
                value={ownerId}
                onChange={(e) => setOwnerId(e.target.value)}
              >
                <option value="">Nobody yet</option>
                {managers.map((manager) => (
                  <option key={manager.userId} value={manager.userId}>
                    {managerName(manager)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Gender">
              {/* Only ever used to pick the right placeholder face. */}
              <Select
                value={gender}
                onChange={(e) => setGender(e.target.value)}
              >
                <option value="">Not stated</option>
                <option value="female">Female</option>
                <option value="male">Male</option>
              </Select>
            </Field>
          </div>

          {/* Whatever this business decided it needs to know, from its own
            settings rather than from this file. */}
          <div className="grid gap-(--gap-toolbar) sm:grid-cols-2">
            <CustomFields
              fields={settings.customFields.filter(
                (f) => f.appliesTo === "contact",
              )}
              values={customValues}
              onChange={setCustomValues}
            />
          </div>

          <Field label="Background">
            <Textarea
              value={background}
              rows={3}
              placeholder="How you met, who introduced you, what they care about"
              onChange={(e) => setBackground(e.target.value)}
            />
          </Field>

          <label className="flex items-center gap-(--gap-toolbar) text-sm">
            <input
              type="checkbox"
              checked={hasNewsletter}
              onChange={(e) => setHasNewsletter(e.target.checked)}
            />
            They agreed to receive the newsletter
          </label>

          <label className="flex items-start gap-(--gap-toolbar) text-sm">
            <input
              type="checkbox"
              className="mt-(--gap-tight)"
              checked={doNotSell}
              onChange={(e) => setDoNotSell(e.target.checked)}
            />
            <span>
              They asked not to have their information sold or shared
              <span className="block" style={muted}>
                Marked on every export of your contacts, so whoever opens the
                file can see it. Different from unsubscribing, which is about
                contacting them.
              </span>
            </span>
          </label>

          <Toolbar>
            {/*
              A form's Save fires from the form, not from the button, so the
              sweep that gated four hundred controls never saw this one — and
              the route it posts to is generated from a template, so the route
              side could not see it either. Both blind spots at once, on the
              biggest record form in the CRM.

              `create` rather than `update` because this form does both and a
              person who may only update an existing contact still cannot make
              a new one here; the route asks for `create` on the POST.
            */}
            <Button
              type="submit"
              needs={{ crm: [contact ? "update" : "create"] }}
              disabled={save.isPending || !named}
            >
              {save.isPending
                ? "Saving…"
                : contact
                  ? "Save changes"
                  : "Create contact"}
            </Button>
            <Button variant="secondary" onClick={() => onDone()}>
              Cancel
            </Button>
            {!named ? (
              <span className="text-sm" style={muted}>
                A first or last name is needed.
              </span>
            ) : null}
          </Toolbar>

          {save.error ? <ErrorNote error={save.error} /> : null}
        </form>
      </Card>
    </Page>
  );
}
