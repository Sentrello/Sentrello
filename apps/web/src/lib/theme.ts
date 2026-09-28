import { useEffect, useState } from "react";

/**
 * Light, dark, or whatever the machine is set to.
 *
 * "System" is the default and stays a real option rather than being collapsed
 * into a two-way switch: someone whose laptop turns dark at sunset wants the
 * app to follow, and a toggle cannot express that. It is only once they
 * disagree with the machine that an explicit choice means anything.
 */
export type Theme = "light" | "dark" | "system";

const KEY = "sentrello.theme";

export function storedTheme(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    if (value === "light" || value === "dark" || value === "system") {
      return value;
    }
  } catch {
    // Private browsing, or storage disabled. Following the system is a fine
    // place to land, and it is what happens anyway.
  }
  return "system";
}

/**
 * Applied to the root element, where the CSS is waiting for it.
 *
 * "System" removes the attribute rather than writing a value, so the media
 * query takes over again — writing "light" would pin it and stop it following
 * the machine, which is the one thing "system" is for.
 */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

/**
 * Set before React renders, from a script in index.html.
 *
 * Without it the page paints light, then corrects itself once the app mounts —
 * a white flash on every load for anyone using dark, which reads as a bug.
 */
export function themeBootstrapScript(): string {
  return `try{var t=localStorage.getItem(${JSON.stringify(KEY)});if(t==="dark"||t==="light")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;
}

export function useTheme(): [Theme, (next: Theme) => void] {
  const [theme, set] = useState<Theme>(storedTheme);

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // Not being able to remember the choice is not a reason to refuse it.
    }
  }, [theme]);

  return [theme, set];
}
