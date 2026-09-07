import { useEffect, useState } from "react";
import { loadModuleScreen } from "../lib/module-ui";
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
}: {
  moduleId: string;
  screenId: string;
  label: string;
}) {
  const [state, setState] = useState<{
    status: "loading" | "ready" | "missing";
    Screen?: () => React.ReactElement | null;
  }>({ status: "loading" });

  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    loadModuleScreen(moduleId, screenId).then((Screen) => {
      if (!live) return;
      setState(Screen ? { status: "ready", Screen } : { status: "missing" });
    });
    return () => {
      live = false;
    };
  }, [moduleId, screenId]);

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
