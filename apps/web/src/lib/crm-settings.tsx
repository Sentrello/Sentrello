import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

/**
 * What this business calls its own pipeline, statuses and categories.
 *
 * Every CRM screen needs some of this and none of them should be hard-coding
 * it: a roofer's stages are not a consultancy's, and a status list a
 * developer picked is the thing that makes a CRM feel like somebody else's.
 *
 * Defaults live here as well as on the server so a screen rendering before
 * the request lands shows the right shape rather than an empty select.
 */

export interface ContactStatus {
  id: string;
  label: string;
  color: string;
}

export interface DealStage {
  id: string;
  label: string;
}

/**
 * A field a business added for itself. See the module SDK's custom-fields.ts.
 *
 * `appliesTo` is a string rather than the CRM's three subjects: the same
 * definition is used by the accounting module for bills and money in and out,
 * and the server checks each module's own list. Narrowing it here would make
 * the shared editor unusable anywhere but the CRM.
 */
export interface CustomField {
  id: string;
  label: string;
  type: "text" | "number" | "date" | "select" | "checkbox";
  options?: string[];
  appliesTo: string;
}

export interface CrmSettings {
  dealStages: DealStage[];
  taskTypes: string[];
  contactStatuses: ContactStatus[];
  dealCategories: string[];
  companySectors: string[];
  wonStages: string[];
  lostStages: string[];
  customFields: CustomField[];
  usingDefaults: boolean;
}

export const FALLBACK_SETTINGS: CrmSettings = {
  dealStages: [
    { id: "opportunity", label: "Opportunity" },
    { id: "proposal", label: "Proposal" },
    { id: "negotiation", label: "Negotiation" },
    { id: "won", label: "Won" },
    { id: "lost", label: "Lost" },
  ],
  taskTypes: ["call", "email", "meeting", "other"],
  contactStatuses: [
    { id: "cold", label: "Cold", color: "#7dbde8" },
    { id: "warm", label: "Warm", color: "#e8cb7d" },
    { id: "hot", label: "Hot", color: "#e88b7d" },
    { id: "in-contract", label: "In contract", color: "#a4e87d" },
  ],
  dealCategories: ["New business", "Repeat business", "Maintenance", "Other"],
  companySectors: [],
  wonStages: ["won"],
  lostStages: ["lost"],
  customFields: [],
  usingDefaults: true,
};

export function useCrmSettings(): CrmSettings {
  const { data } = useQuery({
    queryKey: ["crm-settings"],
    queryFn: () => api<CrmSettings>("/api/crm/settings"),
    /**
     * Settings change about once a year. Refetching them on every screen
     * change costs a request each time and can never show anything new.
     */
    staleTime: 5 * 60 * 1000,
  });
  return data ?? FALLBACK_SETTINGS;
}

/**
 * A status as a coloured dot.
 *
 * The dot is what makes a list of two hundred contacts scannable — the eye
 * finds the four hot ones without reading a single word. The colour is a
 * stored hex value validated on the server, so it goes into `background`
 * rather than into a class name.
 */
export function StatusDot({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-2 shrink-0 rounded-full"
      style={{ background: color }}
    />
  );
}

/**
 * Whoever can own a record in this CRM.
 *
 * Not a list this module keeps — it is derived from the platform's own roles,
 * so somebody given the Sales role in Users appears here and somebody who
 * leaves stops appearing, with no second screen to remember to visit.
 */
export interface Manager {
  userId: string;
  name: string | null;
  email: string;
  image: string | null;
  roles: string[];
}

export function useCrmManagers(): Manager[] {
  const { data } = useQuery({
    queryKey: ["crm-managers"],
    queryFn: () => api<{ managers: Manager[] }>("/api/crm/managers"),
    staleTime: 5 * 60 * 1000,
  });
  return data?.managers ?? [];
}

/** What to call somebody in a list: their name, or their email if unnamed. */
export function managerName(manager: Manager): string {
  return manager.name?.trim() || manager.email;
}
