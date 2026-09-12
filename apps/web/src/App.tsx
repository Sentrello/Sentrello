import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { type Meta, api } from "./lib/api";
import { AppShell } from "./lib/app-shell";
import { signOut, useSession } from "./lib/auth";
import { setModuleRelease } from "./lib/module-ui";
import {
  Breadcrumb,
  NavigationProvider,
  useNavigation,
} from "./lib/navigation";
import { Loading, setFormats } from "./lib/ui";
import {
  Accounts,
  Assets,
  Banking,
  Bills,
  Budgets,
  Journal,
  Money,
  Reports,
  Summary,
  TaxAndCurrency,
} from "./routes/accounting";
import { Companies, CompanyDetail } from "./routes/companies";
import { ContactDetail } from "./routes/contact-detail";
import { Contacts } from "./routes/contacts";
import { CrmDashboard } from "./routes/crm-dashboard";
import { CrmSettings } from "./routes/crm-settings";
import { Dashboard } from "./routes/dashboard";
import { DealDetail } from "./routes/deal-detail";
import { Deals } from "./routes/deals";
import { ResetPassword } from "./routes/forgot-password";
import { Forms } from "./routes/forms";
import { InvoiceDetail } from "./routes/invoice-detail";
import { Invoices } from "./routes/invoices";
import { InvoicingDashboard } from "./routes/invoicing-dashboard";
import { InvoicingSettings } from "./routes/invoicing-settings";
import { ModuleScreen } from "./routes/module-screen";
import { Privacy } from "./routes/privacy";
import { type Profile, ProfileScreen } from "./routes/profile";
import { Quotes } from "./routes/quotes";
import { Recurring } from "./routes/recurring";
import {
  Settings,
  SettingsIntegrations,
  SettingsLicence,
  SettingsModules,
} from "./routes/settings";
import { Setup } from "./routes/setup";
import { SignIn } from "./routes/sign-in";
import { Subscriptions } from "./routes/subscriptions";
import { Authentication } from "./routes/users/authentication";
import { Events } from "./routes/users/events";
import { GroupDetail } from "./routes/users/group";
import { Groups } from "./routes/users/groups";
import { People } from "./routes/users/people";
import { PersonDetail } from "./routes/users/person";
import { Policies } from "./routes/users/policies";
import { PolicyDetail } from "./routes/users/policy";
import { Providers } from "./routes/users/providers";
import { Sessions } from "./routes/users/sessions";
import { VatFiling } from "./routes/vat-filing";

/**
 * Which screen a nav entry opens.
 *
 * Keyed by the module id the server registered, so a module the licence does
 * not load has no nav entry and no way in. A module whose screens ship
 * elsewhere simply has no entry here yet.
 */
const SCREENS: Record<string, () => React.ReactElement | null> = {
  dashboard: Dashboard,
  "crm-dashboard": CrmDashboard,
  contacts: Contacts,
  companies: Companies,
  deals: Deals,
  "crm-settings": CrmSettings,
  invoicing: Invoices,
  /*
   * Money's front page. The same view invoicing opened on its own before the
   * two halves became one module — one subject, one summary — and the old id
   * stays mapped so a bookmark of it still opens something.
   */
  money: InvoicingDashboard,
  "invoicing-dashboard": InvoicingDashboard,
  "invoicing-settings": InvoicingSettings,
  quotes: Quotes,
  recurring: Recurring,
  subscriptions: Subscriptions,
  /**
   * Accounting, as the pages the sidebar names.
   *
   * `accounting` itself opens the summary: a parent is not a screen, but an
   * older host that treats it as one should still land somewhere useful.
   */
  accounting: Summary,
  "accounting-summary": Summary,
  "accounting-money": Money,
  "accounting-accounts": Accounts,
  "accounting-journal": Journal,
  "accounting-bills": Bills,
  "accounting-banking": Banking,
  "accounting-budgets": Budgets,
  "accounting-assets": Assets,
  "accounting-reports": Reports,
  "accounting-tax": TaxAndCurrency,
  forms: Forms,
  /**
   * Settings, as the pages the sidebar names.
   *
   * `settings` itself opens the business's own details: a parent is not a
   * screen, but an older host that treats it as one should still land
   * somewhere useful.
   */
  settings: Settings,
  "settings-business": Settings,
  "settings-integrations": SettingsIntegrations,
  "settings-licence": SettingsLicence,
  "settings-modules": SettingsModules,
  "settings-privacy": Privacy,
  "accounting-vat": VatFiling,
  users: People,
  "user-groups": Groups,
  "user-policies": Policies,
  "user-sessions": Sessions,
  "user-auth": Authentication,
  "user-providers": Providers,
  "user-events": Events,
  profile: ProfileScreen,
};

/** Screens that show a single record, chosen when navigation names one. */
const RECORD_SCREENS: Record<string, () => React.ReactElement | null> = {
  contacts: ContactDetail,
  companies: CompanyDetail,
  deals: DealDetail,
  invoicing: InvoiceDetail,
  users: PersonDetail,
  "user-groups": GroupDetail,
  "user-policies": PolicyDetail,
};

/**
 * The reader's own preferences, fetched once and handed to the formatters.
 *
 * Before the first screen renders rather than inside one: dates and money are
 * formatted from module-level state, so a screen that paints first would show
 * the wrong currency until something happened to re-render it.
 */
function useProfile(signedIn: boolean) {
  return useQuery({
    // Runs and fails rather than being paused, so the screen can carry on
    // without it. A person's own name is not worth a blank page.
    networkMode: "always",
    queryKey: ["profile"],
    enabled: signedIn,
    queryFn: async () => {
      const profile = await api<Profile>("/api/profile");
      setFormats(profile.preferences);
      return profile;
    },
  });
}

function useMeta(signedIn: boolean) {
  return useQuery({
    queryKey: ["meta"],
    // Both of these need a session, and asking without one is three failed
    // requests behind the sign-in form on every load — noise in the log of
    // whoever is trying to work out why something is wrong.
    enabled: signedIn,
    /*
     * Run it even when the browser says there is no network, so it can fail and
     * be answered from what this device remembers. Paused, it never settles and
     * the application waits for ever on a blank page.
     */
    networkMode: "always",
    queryFn: async () => {
      try {
        const meta = await api<Meta>("/api/_meta");
        // Before any module script is requested, so an upgraded instance never
        // serves the previous release's screen from cache.
        setModuleRelease(meta.version ?? "");
        rememberShape(meta);
        return meta;
      } catch (error) {
        const kept = recallShape();
        if (!kept) throw error;
        setModuleRelease(kept.version ?? "");
        return kept;
      }
    },
  });
}

/** Re-renders when the connection comes or goes, so the two paths can differ. */
function useOnline(): boolean {
  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

function wasSignedIn(): boolean {
  try {
    return localStorage.getItem(WAS_SIGNED_IN) === "1";
  } catch {
    return false;
  }
}

const SHAPE = "sentrello.shape";

/**
 * What this instance is, kept on the device.
 *
 * Not money, and not a record of anything: which modules are loaded, what the
 * navigation looks like, which release is running. The application asks the
 * server on every load and, without this, a reload with no connection left it
 * with nothing to draw — the service worker holds the application, and the
 * application still did not know its own shape.
 *
 * Deliberately the application's own decision rather than the worker quietly
 * caching an API answer. The worker keeps nothing under /api, and it should
 * not: a cached figure about stock or a drawer is a wrong number presented as
 * a fact. This is the shape of the screen, it is stale only after an upgrade,
 * and the next successful load replaces it.
 */
function rememberShape(meta: Meta): void {
  try {
    localStorage.setItem(SHAPE, JSON.stringify(meta));
  } catch {
    // A device that will not store it simply does not survive a reload offline.
  }
}

function recallShape(): Meta | null {
  try {
    const held = localStorage.getItem(SHAPE);
    return held ? (JSON.parse(held) as Meta) : null;
  } catch {
    return null;
  }
}

/**
 * The nav renders only what the server loaded, which is only what the license
 * entitles — the UI can never show a feature the instance isn't licensed for.
 */
function useBootstrap() {
  return useQuery({
    queryKey: ["bootstrap"],
    /*
     * Runs and fails rather than being paused.
     *
     * A paused query never settles, and the application waits on this one
     * before it draws anything — so with the line down it stayed on a blank
     * page for ever. The question it asks ("has anybody claimed this instance
     * yet?") is one an instance somebody is already signed in to has plainly
     * answered.
     */
    networkMode: "always",
    queryFn: () =>
      api<{
        needed: boolean;
        signUpOpen: boolean;
        setupTokenRequired: boolean;
      }>("/api/bootstrap"),
    staleTime: 0,
  });
}

/** The screen for wherever navigation currently points. */
function CurrentScreen({
  nav,
  withScreens,
}: {
  nav: Meta["nav"];
  /** The modules this instance can actually serve screens for. */
  withScreens: string[];
}) {
  const { current } = useNavigation();

  // A module can have a screen for one record as well as a list. Without this
  // the record id is carried around and never used, which is how the previous
  // navigation model quietly prevented anything linking to anything.
  const Screen = current.recordId
    ? (RECORD_SCREENS[current.moduleId] ?? SCREENS[current.moduleId])
    : SCREENS[current.moduleId];
  const entry = nav.find((n) => n.id === current.moduleId);

  return (
    <>
      <Breadcrumb />
      {/*
        A record screen is titled with the record, not with the module.
        
        "Invoices" above INV-0020, or "Contacts" above a person's page, is the
        breadcrumb repeated — and the breadcrumb is directly above it saying
        the same thing. The heading should answer "what am I looking at".
      */}
      <h1 className="mb-4 text-lg font-semibold">
        {current.recordId ? current.title : (entry?.label ?? current.title)}
      </h1>
      {Screen ? (
        <Screen />
      ) : (
        // Not a Core screen: the module may have shipped its own. The script is
        // fetched by module id, which is not always the nav id.
        <ModuleScreen
          moduleId={entry?.moduleId ?? current.moduleId}
          screenId={current.moduleId}
          label={entry?.label ?? current.moduleId}
          recordId={current.recordId}
          shipsScreens={withScreens.includes(
            entry?.moduleId ?? current.moduleId,
          )}
        />
      )}
    </>
  );
}

/**
 * Signed in, with nothing here to open.
 *
 * On a customer's own server this means somebody whose membership was removed,
 * which is worth saying plainly rather than showing them a blank page.
 */
function NoAccess() {
  return (
    <div className="mx-auto max-w-md p-8 text-center">
      <p className="font-medium">This account has no access to this instance</p>
      <p className="mt-2 text-sm" style={{ color: "var(--text-muted)" }}>
        Ask an administrator to invite you, or sign in with a different account.
      </p>
      <button
        type="button"
        className="mt-4 text-sm link"
        onClick={async () => {
          await signOut();
          window.location.reload();
        }}
      >
        Sign out
      </button>
    </div>
  );
}

/**
 * Whether the person using this device was signed in last time we could ask.
 *
 * The difference that matters is between "the server says you are not signed
 * in" and "we cannot ask the server". The first is a sign-in screen. The second
 * used to be one too, which meant a till that had kept its menu, kept its
 * queue and survived a reload was still handed a login form it had no way to
 * complete — with its session cookie sitting right there.
 *
 * Remembering this shows nothing that was not already on the device, and grants
 * nothing: every request still carries the cookie and the server still decides.
 * An expired session answers 401 the moment the line comes back, and the
 * application returns to the sign-in screen then, correctly.
 */
const WAS_SIGNED_IN = "sentrello.signed-in";

export default function App() {
  const session = useSession();
  /*
   * Whether the server can be asked at all.
   *
   * `navigator.onLine` rather than the session call's own error, which does not
   * distinguish "no" from "could not ask" — it reports a failed fetch the same
   * way it reports being signed out, and offline that reads as signed out.
   *
   * The browser's flag is famously optimistic: it says online behind a captive
   * portal that answers nothing. That is the safe direction here. Believing it
   * is online when it is not only shows the sign-in screen, which is what used
   * to happen anyway; nothing is trusted on the strength of it.
   */
  const online = useOnline();
  const canAsk = online && !session.error;
  const signedIn = Boolean(session.data) || (!canAsk && wasSignedIn());

  useEffect(() => {
    if (session.isPending || !canAsk) return;
    try {
      if (session.data) localStorage.setItem(WAS_SIGNED_IN, "1");
      else localStorage.removeItem(WAS_SIGNED_IN);
    } catch {
      // A device that will not store it simply asks again next time.
    }
  }, [session.data, session.isPending, canAsk]);
  const meta = useMeta(signedIn);
  const data = meta.data;
  const bootstrap = useBootstrap();
  const profile = useProfile(signedIn);
  const nav = data?.nav ?? [];

  // The emailed reset link lands here with no session, and must be reachable
  // before the sign-in form or the bootstrap screen takes the page.
  if (window.location.pathname === "/reset-password") return <ResetPassword />;

  /*
   * Nothing is drawn until we know who this is and whether the instance has an
   * owner — except when neither can be asked, where waiting is a blank page
   * that never changes. Somebody signed in on this device has answered both.
   */
  if (canAsk && (session.isPending || bootstrap.isLoading)) return null;
  // A fresh instance has no owner yet: claim it before anything else.
  if (bootstrap.data?.needed) {
    return (
      <Setup
        tokenRequired={bootstrap.data.setupTokenRequired}
        onDone={() => window.location.reload()}
      />
    );
  }
  if (!signedIn) return <SignIn />;
  /*
   * Signed in, and the shell does not know what to draw yet. Both of these wait
   * on the session, so they cannot be fetched alongside it.
   *
   * Not while the connection is down: neither will ever arrive, and waiting for
   * them is a spinner that never stops. The shape of the instance is answered
   * from what this device remembers instead, which is enough to draw the screen
   * somebody was on.
   */
  if (canAsk && (meta.isLoading || profile.isLoading)) return <Loading />;

  /**
   * Signed in, but not part of this business.
   *
   * A billing-only account: somebody who bought Sentrello and has a login here
   * solely to manage their subscription. They get sent straight to it and see
   * none of the application — not an empty shell, and certainly not a sidebar
   * full of screens that would refuse them.
   */
  if (data && data.belongsHere === false) {
    if (data.accountPath) {
      window.location.replace(data.accountPath);
      return <Loading />;
    }
    return <NoAccess />;
  }

  // Whatever the server put first, rather than a hard-coded module: a Core
  // instance and a Pro one with a dashboard should each land somewhere that
  // exists, and neither should land on a module the licence did not load.
  const chosen = profile.data?.preferences.landingPage;
  const landing =
    (chosen ? nav.find((n) => n.id === chosen) : undefined) ??
    nav.find((n) => n.id !== "settings") ??
    nav[0];
  if (!landing) return null;

  return (
    <NavigationProvider
      initial={{ moduleId: landing.id, title: landing.label }}
      /**
       * So a path can be checked against the modules this licence actually
       * loaded, rather than opening a screen that does not exist.
       *
       * Plus the screens that are reachable from the shell rather than the
       * sidebar. `Your profile` sits in the account menu and has no nav entry,
       * so `/profile` matched nothing and quietly landed on the dashboard —
       * a page somebody had bookmarked, or been sent a link to, opening
       * somewhere else without saying why.
       */
      known={[...nav, { id: "profile", label: "Your profile" }]}
    >
      {/*
        The session's own copy of who this is, or the profile's, or nothing but
        an address. With the line down there is no session answer to read, and
        the shell only wants a name to put in the corner — not a reason to
        refuse to draw.
      */}
      <AppShell
        nav={nav}
        user={session.data?.user ?? { name: null, email: "" }}
      >
        <CurrentScreen nav={nav} withScreens={data?.ui ?? []} />
      </AppShell>
    </NavigationProvider>
  );
}
