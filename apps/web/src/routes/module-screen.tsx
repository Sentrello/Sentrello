import { useEffect, useState } from "react";
import { loadModuleScreen, setModuleRecord } from "../lib/module-ui";
import { Empty, Loading } from "../lib/ui";

/**
 * Renders a screen that shipped with a module.
 *
 * Kept deliberately dull: fetch, render, or say plainly that there is nothing
 * to show. A module's screen failing to load is a missing page, not a broken
 * application.
 */
export function ModuleScreen({
  moduleId,
  screenId,
  label,
  recordId,
  shipsScreens,
}: {
  moduleId: string;
  screenId: string;
  label: string;
  /** The record this screen was opened for, when it was opened for one. */
  recordId?: string;
  /**
   * Whether this instance has a bundle for this module at all.
   *
   * The instance already says so — `/api/_meta` lists the modules whose screens
   * it can serve — and nothing read it. So opening a section that draws nothing
   * itself, like the CRM's own entry, asked for a bundle that does not exist:
   * a 404 in plain text, which the browser then refuses on MIME grounds and
   * writes to the console. Two errors on a screen whose only fault was having
   * no screen.
   */
  shipsScreens?: boolean;
}) {
  const [state, setState] = useState<{
    status: "loading" | "ready" | "missing";
    Screen?: () => React.ReactElement | null;
  }>({ status: "loading" });

  /*
   * Set before the screen is asked for, so a screen that opens a record reads
   * it on its first render rather than drawing a list and then replacing it.
   */
  setModuleRecord(recordId);

  useEffect(() => {
    let live = true;
    /*
     * Do not ask for what the instance has said it does not have.
     *
     * Undefined means nobody told us, in which case asking is the honest
     * fallback — an older instance, or a screen rendered before the meta
     * arrives.
     */
    if (shipsScreens === false) {
      setState({ status: "missing" });
      return;
    }
    setState({ status: "loading" });
    loadModuleScreen(moduleId, screenId).then((Screen) => {
      if (!live) return;
      setState(Screen ? { status: "ready", Screen } : { status: "missing" });
    });
    return () => {
      live = false;
    };
  }, [moduleId, screenId, shipsScreens]);

  if (state.status === "loading") return <Loading />;
  if (state.status === "missing" || !state.Screen) {
    return (
      <Empty title={`${label} has no screens yet`}>
        The module is enabled and its API is live. Its screens arrive in a later
        release.
      </Empty>
    );
  }

  const { Screen } = state;
  return <Screen />;
}
