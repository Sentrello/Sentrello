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
     * When the default policies and groups were put in place.
     *
     * A marker rather than a count, so seeding happens once and stays undone.
     * A business that deleted five of the six default groups must not find
     * them back tomorrow, and one that edited "Managers" must not have the
     * edit reverted — both of which a "create anything missing" seed would do
     * every time it ran.
     */
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
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("invitation_organizationId_idx").on(table.organizationId),
    index("invitation_email_idx").on(table.email),
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

