import { useState } from "react";
import { Input } from "./ui";

/**
 * The box you type a choice field's answers into.
 *
 * It exists because the obvious version does not work. Render
 * `options.join(", ")` into a controlled input and parse it back on every
 * keystroke, and the comma you just typed produces `["Sales", ""]`, the empty
 * tail is dropped, and the value rendered back is `"Sales"` — the separator
 * is deleted by the keystroke that types it. A second choice could never be
 * typed, only pasted. The space after a comma went the same way.
 *
 * So the text is the state, and the parsed array is what leaves. Seeded once
 * per field, which is all that is needed: the rows are keyed by field name,
 * so editing a different field mounts a different box.
 */
export function parseChoices(text: string): string[] {
  return text
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

export function ChoiceOptionsInput({
  options,
  onChange,
  label,
  placeholder = "Sales, Support, Accounts",
  className,
}: {
  options: string[];
  onChange: (options: string[]) => void;
  label: string;
  placeholder?: string;
  className?: string;
}) {
  const [text, setText] = useState(() => options.join(", "));
  return (
    <Input
      className={className}
      value={text}
      placeholder={placeholder}
      aria-label={`Choices for ${label}`}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseChoices(e.target.value));
      }}
    />
  );
}
