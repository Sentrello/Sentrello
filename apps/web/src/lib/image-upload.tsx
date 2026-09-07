import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Avatar } from "./avatar";
import { ErrorNote, muted } from "./ui";

/**
 * Putting a picture on a record, and taking it off again.
 *
 * The same control for a person and for a company — the only differences are
 * the shape it draws and the words it uses, and two nearly identical uploaders
 * is exactly how one of them ends up missing the size check.
 *
 * The file goes up as it is. Resizing in the browser first would be faster on
 * a slow connection, and would also mean trusting the browser to have done it:
 * the server re-encodes everything anyway, because that re-encoding is what
 * makes an uploaded file safe to serve back.
 */
export function ImageUpload({
  subject,
  id,
  name,
  hasImage,
  rounded = "full",
}: {
  /** Which collection the record is in, matching the API path. */
  subject: "contacts" | "companies";
  id: string;
  name: string;
  /** Whether the record already carries one, so the control can offer Remove. */
  hasImage: boolean;
  rounded?: "full" | "md";
}) {
  const qc = useQueryClient();
  const picker = useRef<HTMLInputElement>(null);

  /**
   * Bumped after every change, and appended to the image URL.
   *
   * The picture is served with a long cache — the name changes whenever the
   * bytes do — but *this* URL is keyed on the record, not the file. Without
   * something to break the cache, uploading a new photograph leaves the old
   * one on screen until a hard refresh, which reads as a failed upload.
   */
  const [version, setVersion] = useState(0);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const body = new FormData();
      body.append("image", file);
      const res = await fetch(`/api/crm/${subject}/${id}/image`, {
        method: "POST",
        credentials: "same-origin",
        body,
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(detail.error ?? "that picture could not be used");
      }
      return res.json();
    },
    onSuccess: () => {
      setVersion((v) => v + 1);
      qc.invalidateQueries({ queryKey: [subject] });
    },
  });

  const remove = useMutation({
    mutationFn: () =>
      fetch(`/api/crm/${subject}/${id}/image`, {
        method: "DELETE",
        credentials: "same-origin",
      }),
    onSuccess: () => {
      setVersion((v) => v + 1);
      qc.invalidateQueries({ queryKey: [subject] });
    },
  });

  const showing = hasImage || upload.isSuccess;

  /**
   * Narrow on purpose: the avatar with its controls beneath.
   *
   * Laid out as a row first, and the help text alongside it pushed the record's
   * own name halfway across the card — the picture is not the point of the
   * page, and it should not take the space of the thing that is.
   */
  return (
    <div className="flex w-16 shrink-0 flex-col items-center gap-1">
      <Avatar
        src={
          showing && !remove.isSuccess
            ? `/api/crm/${subject}/${id}/image?v=${version}`
            : null
        }
        name={name}
        size={64}
        rounded={rounded}
      />

      <div className="flex items-center gap-1.5 text-xs">
        <button
          type="button"
          className="link-muted"
          disabled={upload.isPending}
          // Anything up to 5MB, resized on the way in — said in the title
          // rather than in a line of text beside every record.
          title="Add or replace the picture. Anything up to 5MB; it is resized and stored small."
          onClick={() => picker.current?.click()}
        >
          {upload.isPending
            ? "Uploading…"
            : showing && !remove.isSuccess
              ? "Change"
              : "Add"}
        </button>
        {showing && !remove.isSuccess ? (
          <button
            type="button"
            className="link-muted"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            Remove
          </button>
        ) : null}
      </div>
      {upload.error ? (
        <div className="w-48">
          <ErrorNote error={upload.error} />
        </div>
      ) : null}

      <input
        ref={picker}
        type="file"
        // Raster formats only: an SVG is a document that can carry a script,
        // and the server refuses one anyway. Saying so here saves the round
        // trip and the error message.
        accept="image/jpeg,image/png,image/webp,image/gif,image/avif,image/heic"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) upload.mutate(file);
          // Cleared so choosing the same file twice still fires a change.
          e.target.value = "";
        }}
      />
    </div>
  );
}
