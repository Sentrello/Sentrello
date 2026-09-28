import { mkdir, open, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { and, db, eq, schema } from "@sentrello/db";
import {
  type ArchiveDestination,
  type DestinationConfig,
  archiveDestination,
  archiveDestinations,
  registerArchiveDestination,
  secrets,
} from "@sentrello/module-sdk";

/**
 * Where the archives of this instance are kept, and how that is configured.
 *
 * One destination ships here and it is the one that needs no account: a folder
 * on the machine, which by default is the instance's own data directory and can
 * be pointed at anything the operator has mounted — a NAS, an external disk, a
 * network share. That is the honest first step for a self-hoster, and it is
 * also the one that makes the download work: the file has to exist somewhere
 * before a browser can be handed it.
 *
 * Everything else — a bucket, a hosted store of ours — arrives as another
 * implementation of the same interface, registered the same way, configured on
 * the same screen and proved with the same Test connection button. There is no
 * second path, and there will not be one for us either.
 */

const PREFERENCE_KEY = "archive.destination";

export const FOLDER = "folder";

function defaultDirectory(orgId: string): string {
  return join(
    resolve(process.env.SENTRELLO_DATA_DIR ?? "/data"),
    "archives",
    orgId,
  );
}

/** Where this configuration says to write, with the default filled in. */
function directoryOf(config: DestinationConfig): string {
  const chosen = (config.directory ?? "").trim();
  if (!chosen) return config.__default as string;
  if (!isAbsolute(chosen)) {
    throw new Error("the folder has to be a full path, starting with /");
  }
  return chosen;
}

/** Only ever a name we generated, and never anything that could climb out. */
function safeName(name: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(name) || name.includes("..")) {
    throw new Error("that is not a name this destination will write");
  }
  return name;
}

export const folderDestination: ArchiveDestination = {
  id: FOLDER,
  label: "A folder on this server",
  description:
    "Writes the archive to a directory this instance can reach — its own data directory by default, or anywhere you have mounted, such as a NAS or an external disk. Needs no account and no credentials. You can download the file afterwards and then remove the copy here.",
  fields: [
    {
      name: "directory",
      label: "Folder",
      placeholder: "/mnt/archives",
      help: "Leave empty to keep archives in this instance's own data directory. A full path, and it must already exist and be writable by Sentrello.",
    },
  ],

  async test(config) {
    let directory: string;
    try {
      directory = directoryOf(config);
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
    const probe = join(directory, `.sentrello-probe-${crypto.randomUUID()}`);
    try {
      await mkdir(directory, { recursive: true });
      const handle = await open(probe, "w");
      await handle.write(Buffer.from("sentrello"));
      await handle.close();
      // Read it back rather than trusting the write. A directory that accepts
      // writes and returns nothing is exactly the failure this button exists
      // to find, and it happens on more than one kind of network mount.
      const back = await open(probe, "r");
      const { size } = await back.stat();
      await back.close();
      await rm(probe, { force: true });
      if (size !== 9) {
        return {
          ok: false,
          detail: `wrote 9 bytes to ${directory} and read back ${size}`,
        };
      }
      return {
        ok: true,
        detail: `wrote a test file to ${directory} and read it back`,
      };
    } catch (err) {
      await rm(probe, { force: true }).catch(() => {});
      return { ok: false, detail: `${directory}: ${(err as Error).message}` };
    }
  },

  async put(config, name, body) {
    const directory = directoryOf(config);
    await mkdir(directory, { recursive: true });
    const path = join(directory, safeName(name));
    const handle = await open(path, "w", 0o600);
    try {
      // A chunk at a time, never the whole archive: the box this runs on may
      // have less memory than the archive has rows.
      for await (const chunk of body) await handle.write(chunk);
    } finally {
      await handle.close();
    }
    return path;
  },

  async *get(_config, locator) {
    const handle = await open(locator, "r");
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) return;
        yield new Uint8Array(buffer.subarray(0, bytesRead));
      }
    } finally {
      await handle.close();
    }
  },

  async remove(_config, locator) {
    await rm(locator, { force: true });
  },
};

registerArchiveDestination(folderDestination);

export { archiveDestination, archiveDestinations };

export interface StoredDestination {
  id: string;
  config: DestinationConfig;
}

/**
 * What this business chose, with its secrets opened.
 *
 * Secrets are sealed in the row (`@sentrello/module-sdk/secrets`) and never
 * read back to a screen — the settings endpoint answers with the fields that
 * are set, not with what they are set to. A destination we have not heard of,
 * because the module that provided it is no longer loaded, falls back to the
 * folder rather than failing: an instance must always be able to reach the
 * archives it already wrote.
 */
export async function destinationFor(
  orgId: string,
): Promise<StoredDestination> {
  const [row] = await db
    .select({ value: schema.organizationPreferences.value })
    .from(schema.organizationPreferences)
    .where(
      and(
        eq(schema.organizationPreferences.organizationId, orgId),
        eq(schema.organizationPreferences.key, PREFERENCE_KEY),
      ),
    )
    .limit(1);

  const stored = (row?.value ?? {}) as {
    id?: string;
    config?: DestinationConfig;
  };
  const chosen =
    stored.id && archiveDestination(stored.id) ? stored.id : FOLDER;
  const config: DestinationConfig = { __default: defaultDirectory(orgId) };
  for (const [key, value] of Object.entries(stored.config ?? {})) {
    config[key] = secrets.isSealed(String(value))
      ? secrets.open(String(value))
      : String(value);
  }
  return { id: chosen, config };
}

/** Which fields are set, without saying what they are set to. */
export async function destinationSummary(orgId: string) {
  const [row] = await db
    .select({ value: schema.organizationPreferences.value })
    .from(schema.organizationPreferences)
    .where(
      and(
        eq(schema.organizationPreferences.organizationId, orgId),
        eq(schema.organizationPreferences.key, PREFERENCE_KEY),
      ),
    )
    .limit(1);
  const stored = (row?.value ?? {}) as {
    id?: string;
    config?: Record<string, string>;
  };
  const chosen =
    stored.id && archiveDestination(stored.id) ? stored.id : FOLDER;
  return {
    id: chosen,
    defaultDirectory: defaultDirectory(orgId),
    values: Object.fromEntries(
      Object.entries(stored.config ?? {}).map(([key, value]) => [
        key,
        // A sealed value is reported as set and nothing more.
        secrets.isSealed(String(value)) ? "" : value,
      ]),
    ),
    set: Object.entries(stored.config ?? {})
      .filter(([, value]) => Boolean(value))
      .map(([key]) => key),
    available: archiveDestinations().map((destination) => ({
      id: destination.id,
      label: destination.label,
      description: destination.description,
      fields: destination.fields,
    })),
  };
}

export async function saveDestination(
  orgId: string,
  id: string,
  values: Record<string, string>,
) {
  const destination = archiveDestination(id);
  if (!destination) throw new Error(`there is no destination called "${id}"`);

  const config: Record<string, string> = {};
  for (const field of destination.fields) {
    const value = (values[field.name] ?? "").trim();
    if (!value) {
      if (field.required) throw new Error(`${field.label} is needed`);
      continue;
    }
    config[field.name] = field.secret ? secrets.seal(value) : value;
  }

  await db
    .insert(schema.organizationPreferences)
    .values({
      organizationId: orgId,
      key: PREFERENCE_KEY,
      value: { id, config },
    })
    .onConflictDoUpdate({
      target: [
        schema.organizationPreferences.organizationId,
        schema.organizationPreferences.key,
      ],
      set: { value: { id, config }, updatedAt: new Date() },
    });
}

/** How large the file at a locator is, where the destination can say. */
export async function sizeOf(locator: string): Promise<number | null> {
  try {
    return (await stat(locator)).size;
  } catch {
    return null;
  }
}
