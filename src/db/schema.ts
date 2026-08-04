import {
  pgTable,
  text,
  timestamp,
  uuid,
  primaryKey,
  doublePrecision,
  index,
  pgEnum,
  boolean,
} from "drizzle-orm/pg-core";

/**
 * An item's stage of life. The same row moves through these — a pinned idea
 * that gets a time becomes a proposal, and a proposal the Master Planner locks
 * becomes part of the itinerary. Votes, comments and (later) media attach to
 * the item, so the discussion survives the promotion.
 */
export const itemStatus = pgEnum("item_status", [
  "idea",
  "proposed",
  "locked",
  "declined",
]);

/** Private items are visible only to their creator, including in listings. */
export const itemVisibility = pgEnum("item_visibility", ["private", "group"]);

/**
 * Only meaningful once locked. Required items are "on the bus" — everyone is
 * attending. Optional items are booked but opt-in via RSVP.
 */
export const itemCommitment = pgEnum("item_commitment", ["required", "optional"]);

export const itemCategory = pgEnum("item_category", [
  "lodging",
  "dining",
  "activity",
  "transport",
  "other",
]);

export const memberRole = pgEnum("member_role", ["master_planner", "participant"]);

export const rsvpResponse = pgEnum("rsvp_response", ["yes", "no", "maybe"]);

/** Phase is normally derived from the trip dates; this forces it. */
export const tripPhase = pgEnum("trip_phase", ["planning", "active", "completed"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name"),
  /**
   * Null until the user sets one. Magic-link sign-in works either way; a null
   * hash is also the signal that first verification should prompt the user to
   * create a password (see lib/auth.ts's redeemLoginToken).
   */
  passwordHash: text("password_hash"),
  /**
   * No admin surface exists yet — this only marks who a future one should
   * trust. Seeded directly (see db/seed.ts), not settable via the app.
   */
  isAdmin: boolean("is_admin").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable(
  "sessions",
  {
    token: text("token").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/** Single-use magic-link tokens. Delivery is pluggable; see lib/email.ts. */
export const loginTokens = pgTable(
  "login_tokens",
  {
    token: text("token").primaryKey(),
    email: text("email").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("login_tokens_email_idx").on(t.email)],
);

export const trips = pgTable("trips", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  destination: text("destination").notNull(),
  /**
   * Calendar dates, not instants — a trip "starts on the 4th" in the
   * destination's local reckoning regardless of where members are.
   */
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  /** IANA zone of the destination. Items may override for multi-city trips. */
  timezone: text("timezone").notNull().default("UTC"),
  phaseOverride: tripPhase("phase_override"),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tripMembers = pgTable(
  "trip_members",
  {
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRole("role").notNull().default("participant"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tripId, t.userId] }),
    index("trip_members_user_idx").on(t.userId),
  ],
);

export const invites = pgTable(
  "invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    /** Null for a shareable link that anyone with the URL may redeem. */
    email: text("email"),
    role: memberRole("role").notNull().default("participant"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedBy: uuid("accepted_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("invites_trip_idx").on(t.tripId)],
);

export const items = pgTable(
  "items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),

    title: text("title").notNull(),
    notes: text("notes"),
    category: itemCategory("category").notNull().default("activity"),

    locationName: text("location_name"),
    locationLat: doublePrecision("location_lat"),
    locationLng: doublePrecision("location_lng"),

    status: itemStatus("status").notNull().default("idea"),
    visibility: itemVisibility("visibility").notNull().default("group"),
    /** Null until locked. */
    commitment: itemCommitment("commitment"),

    /** Null while the item is still an idea. Stored as UTC instants. */
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    /** IANA zone for display; falls back to the trip's zone. */
    timezone: text("timezone"),

    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: uuid("locked_by").references(() => users.id),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("items_trip_idx").on(t.tripId),
    index("items_trip_status_idx").on(t.tripId, t.status),
    index("items_starts_at_idx").on(t.startsAt),
  ],
);

/**
 * Only recorded for optional items. Attendance on required items is derived
 * from trip membership — see lib/attendance.ts — so nobody can drift off the bus.
 */
export const itemRsvps = pgTable(
  "item_rsvps",
  {
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    response: rsvpResponse("response").notNull(),
    respondedAt: timestamp("responded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.userId] }),
    index("item_rsvps_user_idx").on(t.userId),
  ],
);

export const lodgingPaymentStatus = pgEnum("lodging_payment_status", [
  "prepaid",
  "partial",
  "pay_on_arrival",
]);

/**
 * Category-specific fields for a lodging item, one row per item. A dedicated
 * table rather than nullable columns on `items` itself — keeps the base
 * table from bloating with fields only one category uses, and is the
 * pattern to repeat (dining_details, transport_details, ...) rather than a
 * generic polymorphic blob nobody's asked for yet.
 *
 * Check-in/check-out aren't columns here — they're the item's own
 * `startsAt`/`endsAt`, so a lodging stay slots into the conflict engine and
 * timeline like any other locked item, for free.
 */
export const lodgingDetails = pgTable("lodging_details", {
  itemId: uuid("item_id")
    .primaryKey()
    .references(() => items.id, { onDelete: "cascade" }),
  address: text("address"),
  checkInInstructions: text("check_in_instructions"),
  contactName: text("contact_name"),
  contactPhone: text("contact_phone"),
  contactEmail: text("contact_email"),
  confirmationNumber: text("confirmation_number"),
  /** Must be a member of the trip — enforced in lib/lodging.ts, not here. */
  bookedBy: uuid("booked_by").references(() => users.id),
  paymentStatus: lodgingPaymentStatus("payment_status"),
  bookingUrl: text("booking_url"),
  cancellationDeadline: timestamp("cancellation_deadline", { withTimezone: true }),
  costAmount: doublePrecision("cost_amount"),
  /** ISO 4217, e.g. "USD" — free text, not validated against a currency list. */
  costCurrency: text("cost_currency"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
