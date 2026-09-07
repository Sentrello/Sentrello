import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { COMPANY_SIZES, type Company, api } from "../lib/api";
import {
  type CrmSettings,
  managerName,
  useCrmManagers,
} from "../lib/crm-settings";
import { CustomFields } from "../lib/custom-fields";
import { Icon } from "../lib/icons";
import {
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  Select,
  border,
  muted,
} from "../lib/ui";

/**
 * Creating and editing a company, with every field the record has.
 *
 * Creating one used to ask for a name and a sector, which meant a company was
 * always half-entered and had to be opened and corrected straight afterwards.
 * The groups here are Atomic's — who they are, what they do, where they are,
 * and background — because a company record is read in that order.
 */

/** Links to anywhere else this company exists. */
function ContextLinks({
  values,
  onChange,
}: {
  values: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 block text-sm">Links</legend>
      {values.map((value, i) => (
        // No stable id before saving, and two blank rows are legitimately equal.
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id until saved
        <div key={i} className="flex gap-2">
          <Input
            value={value}
            placeholder="https://…"
            onChange={(e) =>
              onChange(values.map((v, at) => (at === i ? e.target.value : v)))
            }
          />
          <button
            type="button"
            className="link-muted px-1"
            aria-label="Remove this link"
            onClick={() => onChange(values.filter((_, at) => at !== i))}
          >
            <Icon name="trash" size={15} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="text-sm link"
        onClick={() => onChange([...values, ""])}
      >
        Add a link
      </button>
    </fieldset>
  );
}

export function CompanyForm({
  company,
  settings,
  onDone,
}: {
  /** Absent when creating. */
  company?: Company;
  settings: CrmSettings;
  onDone: (saved?: Company) => void;
}) {
  const [name, setName] = useState(company?.name ?? "");
  const [sector, setSector] = useState(company?.sector ?? "");
  const [size, setSize] = useState(company?.size ? String(company.size) : "");
  const [website, setWebsite] = useState(company?.website ?? "");
  const [linkedinUrl, setLinkedinUrl] = useState(company?.linkedinUrl ?? "");
  const [phone, setPhone] = useState(company?.phone ?? "");
  const [revenue, setRevenue] = useState(company?.revenue ?? "");
  const [taxIdentifier, setTaxIdentifier] = useState(
    company?.taxIdentifier ?? "",
  );
  const [address, setAddress] = useState(company?.address ?? "");
  const [city, setCity] = useState(company?.city ?? "");
  const [postcode, setPostcode] = useState(company?.postcode ?? "");
  const [stateName, setStateName] = useState(company?.state ?? "");
  const [country, setCountry] = useState(company?.country ?? "");
  const [description, setDescription] = useState(company?.description ?? "");
  const [contextLinks, setContextLinks] = useState<string[]>(
    company?.contextLinks ?? [],
  );
  const [ownerId, setOwnerId] = useState(company?.ownerId ?? "");
  const [customValues, setCustomValues] = useState<
    Record<string, string | number | boolean | null>
  >(company?.customValues ?? {});
  const managers = useCrmManagers();

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: name.trim(),
        sector: sector || null,
        // The band's top value, so the column sorts the way the labels read.
        size: size ? Number(size) : null,
        website: website.trim() || null,
        linkedinUrl: linkedinUrl.trim() || null,
        phone: phone.trim() || null,
        revenue: revenue.trim() || null,
        taxIdentifier: taxIdentifier.trim() || null,
        address: address.trim() || null,
        city: city.trim() || null,
        postcode: postcode.trim() || null,
        state: stateName.trim() || null,
        country: country.trim() || null,
        description: description.trim() || null,
        contextLinks: contextLinks.map((l) => l.trim()).filter(Boolean),
        ownerId: ownerId || null,
        customValues,
      };
      const res = await api<{ company: Company }>(
        company ? `/api/companies/${company.id}` : "/api/companies",
        { method: company ? "PATCH" : "POST", body: JSON.stringify(body) },
      );
      return res.company;
    },
    onSuccess: (saved) => onDone(saved),
  });

  return (
    <Card>
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) save.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <Input
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Sector">
            <Select value={sector} onChange={(e) => setSector(e.target.value)}>
              <option value="">Not stated</option>
              {settings.companySectors.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Size">
            <Select value={size} onChange={(e) => setSize(e.target.value)}>
              <option value="">Not stated</option>
              {COMPANY_SIZES.map((band) => (
                <option key={band.id} value={band.id}>
                  {band.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Revenue" hint="However this business talks about it.">
            <Input
              value={revenue}
              onChange={(e) => setRevenue(e.target.value)}
            />
          </Field>
          <Field
            label="Tax identifier"
            hint="VAT number, EIN, GST/HST — whatever applies."
          >
            <Input
              value={taxIdentifier}
              onChange={(e) => setTaxIdentifier(e.target.value)}
            />
          </Field>
        </div>

        <div className="grid gap-3 border-t pt-4 sm:grid-cols-4" style={border}>
          <Field label="Website">
            <Input
              value={website}
              placeholder="https://…"
              onChange={(e) => setWebsite(e.target.value)}
            />
          </Field>
          <Field label="LinkedIn">
            <Input
              value={linkedinUrl}
              placeholder="https://linkedin.com/company/…"
              onChange={(e) => setLinkedinUrl(e.target.value)}
            />
          </Field>
          <Field label="Phone">
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
          <Field label="Account manager" hint="Whose account this is.">
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
        </div>

        <div className="grid gap-3 border-t pt-4 sm:grid-cols-2" style={border}>
          <Field label="Address">
            <Input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </Field>
          <Field label="City">
            <Input value={city} onChange={(e) => setCity(e.target.value)} />
          </Field>
          <Field label="Postcode">
            <Input
              value={postcode}
              onChange={(e) => setPostcode(e.target.value)}
            />
          </Field>
          <Field label="State or region">
            <Input
              value={stateName}
              onChange={(e) => setStateName(e.target.value)}
            />
          </Field>
          <Field label="Country">
            <Input
              value={country}
              onChange={(e) => setCountry(e.target.value)}
            />
          </Field>
        </div>

        <div className="grid gap-4 border-t pt-4 sm:grid-cols-2" style={border}>
          <Field label="Description">
            <textarea
              value={description}
              rows={4}
              placeholder="What they do, and what the relationship is"
              onChange={(e) => setDescription(e.target.value)}
              className="w-full rounded-md border px-2 py-1.5 text-sm"
              style={{ ...border, background: "var(--surface-raised)" }}
            />
          </Field>
          <ContextLinks values={contextLinks} onChange={setContextLinks} />
        </div>

        {/* This business's own fields, from its settings rather than here. */}
        <div className="grid gap-3 sm:grid-cols-2">
          <CustomFields
            fields={settings.customFields.filter(
              (f) => f.appliesTo === "company",
            )}
            values={customValues}
            onChange={setCustomValues}
          />
        </div>

        <div className="flex items-center gap-2">
          <Button type="submit" disabled={save.isPending || !name.trim()}>
            {save.isPending
              ? "Saving…"
              : company
                ? "Save changes"
                : "Create company"}
          </Button>
          <Button variant="secondary" onClick={() => onDone()}>
            Cancel
          </Button>
          {!name.trim() ? (
            <span className="text-sm" style={muted}>
              A name is needed.
            </span>
          ) : null}
        </div>

        {save.error ? <ErrorNote error={save.error} /> : null}
      </form>
    </Card>
  );
}
