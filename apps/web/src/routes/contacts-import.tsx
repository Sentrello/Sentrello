import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { type Sheet, guessMapping, parseCsv } from "../lib/csv";
import { Button, Card, ErrorNote, Row, Select, Table, muted } from "../lib/ui";

/**
 * Bringing a spreadsheet in.
 *
 * Nobody's export has our column names, so the mapping step is the whole
 * feature — an importer that demands a particular header row is an importer
 * nobody can use. The guess is made first and shown as a set of dropdowns,
 * because correcting a wrong guess is faster than making ten right ones.
 */

export const FIELDS = [
  {
    key: "firstName",
    label: "First name",
    aliases: ["given name", "forename"],
  },
  { key: "lastName", label: "Last name", aliases: ["surname", "family name"] },
  { key: "email", label: "Email", aliases: ["email address", "e-mail"] },
  {
    key: "phone",
    label: "Phone",
    aliases: ["telephone", "mobile", "phone number"],
  },
  {
    key: "company",
    label: "Company",
    aliases: ["organisation", "organization", "account"],
  },
  { key: "title", label: "Job title", aliases: ["role", "position"] },
  { key: "linkedinUrl", label: "LinkedIn", aliases: ["linkedin url"] },
];

interface Result {
  imported: number;
  companiesCreated: number;
  skipped: { row: number; why: string }[];
}

export function ContactsImport({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [result, setResult] = useState<Result | null>(null);
  const [readError, setReadError] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: async () => {
      if (!sheet) throw new Error("no file");
      const columnIndex = new Map(sheet.headers.map((h, i) => [h, i]));
      const rows = sheet.rows.map((r) => {
        const out: Record<string, string> = {};
        for (const field of FIELDS) {
          const header = mapping[field.key];
          if (!header) continue;
          const at = columnIndex.get(header);
          if (at !== undefined) out[field.key] = r[at] ?? "";
        }
        return out;
      });
      return api<Result>("/api/contacts/import", {
        method: "POST",
        body: JSON.stringify({ rows }),
      });
    },
    onSuccess: (r) => {
      setResult(r);
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["companies"] });
    },
  });

  async function readFile(file: File) {
    setReadError(null);
    setResult(null);
    try {
      const parsed = parseCsv(await file.text());
      if (parsed.headers.length === 0 || parsed.rows.length === 0) {
        setReadError("That file has no rows in it.");
        return;
      }
      setSheet(parsed);
      setMapping(guessMapping(parsed.headers, FIELDS));
    } catch {
      setReadError("That file could not be read as a CSV.");
    }
  }

  if (result) {
    return (
      <Card>
        <p className="font-medium">
          Imported {result.imported} contact
          {result.imported === 1 ? "" : "s"}
          {result.companiesCreated
            ? `, creating ${result.companiesCreated} compan${result.companiesCreated === 1 ? "y" : "ies"}`
            : ""}
          .
        </p>
        {result.skipped.length ? (
          // Named rather than counted: "20 skipped" leaves somebody comparing
          // two spreadsheets to find out which twenty.
          <div className="mt-2 text-sm">
            <p style={muted}>
              {result.skipped.length} row
              {result.skipped.length === 1 ? "" : "s"} skipped:
            </p>
            <ul className="mt-1 space-y-0.5">
              {result.skipped.slice(0, 10).map((s) => (
                <li key={s.row} style={muted}>
                  Row {s.row} — {s.why}
                </li>
              ))}
              {result.skipped.length > 10 ? (
                <li style={muted}>…and {result.skipped.length - 10} more</li>
              ) : null}
            </ul>
          </div>
        ) : null}
        <div className="mt-3">
          <Button onClick={onDone}>Done</Button>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <p className="mb-2 font-medium">Import contacts from a spreadsheet</p>
      <p className="mb-3 text-sm" style={muted}>
        A CSV exported from a spreadsheet or another CRM. Nothing is written
        until you press Import.
      </p>

      <input
        type="file"
        accept=".csv,text/csv"
        aria-label="CSV file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) readFile(file);
        }}
        className="text-sm"
      />
      {readError ? (
        <p className="mt-2 text-sm" style={{ color: "var(--color-danger)" }}>
          {readError}
        </p>
      ) : null}

      {sheet ? (
        <>
          <p className="mt-4 mb-2 text-sm" style={muted}>
            {sheet.rows.length} row{sheet.rows.length === 1 ? "" : "s"} found.
            Check the columns line up.
          </p>

          <Table headers={["Sentrello field", "Your column", "First value"]}>
            {FIELDS.map((f) => {
              const chosen = mapping[f.key] ?? "";
              const at = sheet.headers.indexOf(chosen);
              const sample = at >= 0 ? (sheet.rows[0]?.[at] ?? "") : "";
              return (
                <Row key={f.key}>
                  <td className="py-2">{f.label}</td>
                  <td>
                    <Select
                      value={chosen}
                      aria-label={`Column for ${f.label}`}
                      onChange={(e) =>
                        setMapping((m) => ({ ...m, [f.key]: e.target.value }))
                      }
                    >
                      <option value="">— skip —</option>
                      {sheet.headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td style={muted}>{sample || "—"}</td>
                </Row>
              );
            })}
          </Table>

          <div className="mt-3 flex items-center gap-2">
            <Button
              onClick={() => run.mutate()}
              // A name is the one thing a contact cannot be created without.
              disabled={
                run.isPending || (!mapping.firstName && !mapping.lastName)
              }
            >
              {run.isPending ? "Importing…" : `Import ${sheet.rows.length}`}
            </Button>
            <button
              type="button"
              className="text-sm link-muted"
              onClick={onDone}
            >
              Cancel
            </button>
          </div>
          {!mapping.firstName && !mapping.lastName ? (
            <p className="mt-2 text-sm" style={muted}>
              Choose a column for at least one name field.
            </p>
          ) : null}
          {run.error ? <ErrorNote error={run.error} /> : null}
        </>
      ) : null}
    </Card>
  );
}
