import { relations } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  boolean,
  index,
  integer,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  // Written by Better Auth's two-factor plugin, and only once a code has
  // actually been verified — enabling without proving the authenticator works
  // is how somebody locks themselves out of their own books.
  twoFactorEnabled: boolean("two_factor_enabled").default(false),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    activeOrganizationId: text("active_organization_id"),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const organizations = pgTable(
  "organizations",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    logo: text("logo"),
    createdAt: timestamp("created_at").notNull(),
    metadata: text("metadata"),

    /**
     * Who the business is, on every document a customer receives.
     *
     * A name alone is not an invoice. In the UK and across the EU an invoice
     * must carry the seller's address, and a VAT invoice must carry the
     * registration number — without them the document a customer files is not
     * a valid one. Payment instructions are the practical half: a business
     * paid by bank transfer whose invoices omit its account details fields a
     * "where do I send this?" reply to every single one.
     *
     * Free text rather than structured fields, because the shape of an address
     * and the name of a tax number differ by country, and a micro-business
     * knows its own better than a form does.
     */
    address: text("address"),
    taxId: text("tax_id"),
    /** Labelled by the business, e.g. "VAT number", "ABN", "EIN". */
    taxIdLabel: text("tax_id_label"),
    paymentInstructions: text("payment_instructions"),

    /**
     * The seller's address, in parts.
     *
     * `address` above is one free-text block, which is right for printing at
     * the top of an invoice and useless for a structured e-invoice: EN 16931
     * makes the seller's country code mandatory (BT-40) and a country cannot be
     * reliably read out of a line somebody typed. These are additive and
     * optional — a business that never sends a structured invoice is not asked
     * for them — and the e-invoice refuses to generate without the ones it
     * needs rather than emitting something a tax authority will reject.
     */
    city: text("city"),
    postcode: text("postcode"),
    /** ISO 3166-1 alpha-2. "DE", not "Germany". */
    countryCode: text("country_code"),
    /**
     * How the business itself is reached, as a structured e-invoice states it.
     *
     * Germany's rules (BR-DE-5/6/7) make a seller contact point — name, phone,
     * email — mandatory on every XRechnung, and an invoice into a German
     * public body will not validate without one. Optional here for the same
     * reason the address parts are: only the e-invoice needs them, and it
     * refuses with the field named rather than emitting a document a machine
     * rejects.
     */
    email: text("email"),
    phone: text("phone"),
    /**
     * Where a bank transfer goes, as a machine reads it.
     *
     * `paymentInstructions` above is prose for a person; an XRechnung needs
     * the IBAN itself (BR-DE-1 makes payment instructions mandatory, and a
     * SEPA credit transfer must carry the account). Stored plainly — an IBAN
     * is printed on every invoice a business sends, not a secret.
     */
    iban: text("iban"),
    /**
     * The currency the books are kept in.
     *
     * Documents may be raised in anything; the ledger is one currency or its
     * reports cannot be added up. A bill in euros is converted at the rate
     * that applied on its date, and the difference by the time it is paid is
     * an exchange gain or loss rather than a number that quietly does not
     * balance.
     */
    baseCurrency: text("base_currency").notNull().default("USD"),
    /**
     * Where the business is, in time.
     *
     * An IANA name — "America/New_York", "Europe/London" — because an offset is
     * wrong twice a year and a business that says nine o'clock means nine
     * o'clock in both March and November.
     *
     * Null means the server's own, which is right for a self-hosted box sitting
     * in the office and wrong for one rented in another country. Everything
     * that acts at a *time of day* reads this: an automation that chases quiet
     * deals every Monday at nine went out on Sunday evening for a business
     * whose server was in Frankfurt, and nothing anywhere explained why.
     */
    timezone: text("timezone"),
    /**
     * When the default policies and groups were put in place.
     *
     * A marker rather than a count, so seeding happens once and stays undone.
     * A business that deleted five of the six default groups must not find
     * them back tomorrow, and one that edited "Managers" must not have the
     * edit reverted — both of which a "create anything missing" seed would do
     * every time it ran.
     */
    /**
     * The credit at the foot of a page a visitor sees, for a business that
     * wants its own there.
     *
     * A Free instance carries "Powered by Sentrello" on every thank-you page,
     * and that is part of what Free is. Pro is paid for, and a paying business
     * may put its own agency, its own group, or nothing at all — an empty text
     * is the "remove branding" case and is deliberately distinguishable from
     * never having set one.
     *
     * Ignored on Free, where the credit is not the business's to change.
     */
    creditText: text("credit_text"),
    creditUrl: text("credit_url"),
    accessSeededAt: timestamp("access_seeded_at"),
  },
  (table) => [uniqueIndex("organizations_slug_uidx").on(table.slug)],
);

export const member = pgTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /**
     * What this person may do, as Better Auth reads it.
     *
     * Comma separated, and computed rather than typed: it is the person's own
     * role plus the roles of every group they are in. Better Auth splits it
     * and allows a permission if any of the roles grants it, so every check in
     * the platform keeps working without knowing groups exist.
     */
    role: text("role").default("member").notNull(),
    /**
     * The role this person was given directly, apart from any group.
     *
     * Kept because `role` is derived: without it, taking somebody out of a
     * group could not tell which of their roles was theirs to begin with.
     */
    baseRole: text("base_role"),
    /**
     * Set while an account is suspended.
     *
     * A person who has left, or one whose laptop is missing, should stop being
     * able to sign in without their invoices losing their author. Deleting a
     * member who owns records is destructive in a way suspending them is not.
     */
    disabledAt: timestamp("disabled_at"),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    index("member_organizationId_idx").on(table.organizationId),
    index("member_userId_idx").on(table.userId),
  ],
);

export const invitation = pgTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").default("pending").notNull(),
    /**
     * SHA-256 of the invitation link's token, hex.
     *
     * The link is a credential — whoever holds it joins the business — so it
     * is treated like a password: the plaintext token appears exactly once,
     * in the link handed back when the invitation is created, and only its
     * hash is kept. A copy of this database is not a way in.
     *
     * Null on rows created before links existed, or through the raw API;
     * those rows have no working link, only the email carve-out in
     * `signUpAllowed`.
     */
    tokenHash: text("token_hash"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("invitation_organizationId_idx").on(table.organizationId),
    index("invitation_email_idx").on(table.email),
    // Unique so one token can only ever name one invitation — and it is how
    // the accept route finds the row, so it is the lookup index too.
    uniqueIndex("invitation_token_hash_uidx").on(table.tokenHash),
  ],
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  members: many(member),
  invitations: many(invitation),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

export const organizationsRelations = relations(organizations, ({ many }) => ({
  members: many(member),
  invitations: many(invitation),
}));

export const memberRelations = relations(member, ({ one }) => ({
  organizations: one(organizations, {
    fields: [member.organizationId],
    references: [organizations.id],
  }),
  user: one(user, {
    fields: [member.userId],
    references: [user.id],
  }),
}));

export const invitationRelations = relations(invitation, ({ one }) => ({
  organizations: one(organizations, {
    fields: [invitation.organizationId],
    references: [organizations.id],
  }),
  user: one(user, {
    fields: [invitation.inviterId],
    references: [user.id],
  }),
}));

/**
 * The two-factor plugin's table. Its shape is the plugin's contract, not ours.
 *
 * The secret is encrypted by Better Auth with the instance's auth secret
 * before it arrives here, so a database backup does not carry usable
 * authenticator seeds — which matters more on self-hosted machines, where the
 * backup often sits on the same disk.
 */
export const twoFactor = pgTable(
  "two_factor",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    verified: boolean("verified").default(true),
    // The plugin's own rate limit: enough wrong codes and it stops accepting
    // any for a while, which is what makes a six-digit number worth having.
    failedVerificationCount: integer("failed_verification_count").default(0),
    lockedUntil: timestamp("locked_until"),
  },
  (table) => [index("two_factor_user_id_idx").on(table.userId)],
);

/**
 * An identity provider a business signs in through.
 *
 * Better Auth's SSO plugin owns these rows; the shape is its own, and it is
 * written here because this platform keeps its schema in one place rather than
 * letting a library create tables behind it.
 *
 * `oidcConfig` and `samlConfig` are JSON as text, and they contain the client
 * secret for the connection. That is the library's design, not ours — it is
 * noted in the module's docs as the one credential on the instance not sealed
 * the way the payment keys are.
 */
export const ssoProvider = pgTable(
  "sso_provider",
  {
    id: text("id").primaryKey(),
    /** The identity provider's own issuer URL. */
    issuer: text("issuer").notNull(),
    oidcConfig: text("oidc_config"),
    samlConfig: text("saml_config"),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    /** How a sign-in names this connection. Unique across the instance. */
    providerId: text("provider_id").notNull().unique(),
    organizationId: text("organization_id"),
    /** The email domain that arrives here — `example.com`. */
    domain: text("domain").notNull(),
  },
  (table) => [
    index("sso_provider_organizationId_idx").on(table.organizationId),
    index("sso_provider_domain_idx").on(table.domain),
  ],
);

