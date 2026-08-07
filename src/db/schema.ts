import {
  pgTable,
  text,
  timestamp,
  uuid,
  primaryKey,
  doublePrecision,
  integer,
  index,
  uniqueIndex,
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

/**
 * A fixed, checkable vocabulary rather than free text — the whole point is
 * to eventually cross-reference this against a dining item's cuisine/menu
 * tags and raise a warning automatically. Anything that doesn't fit a tag
 * (severity, a specific ingredient) belongs in dietaryNotes instead.
 */
export const dietaryTag = pgEnum("dietary_tag", [
  "vegetarian",
  "vegan",
  "pescatarian",
  "gluten_free",
  "dairy_free",
  "nut_free",
  "shellfish_free",
  "halal",
  "kosher",
  "low_carb",
]);

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
   * Both null/empty until a user opts in via their profile. Global to the
   * user rather than per-trip -- an allergy doesn't change trip to trip.
   * Once set, it's visible to co-members on any trip they're on (see
   * scope.ts) -- that's the disclosure; there's no separate per-trip toggle.
   */
  dietaryRestrictions: dietaryTag("dietary_restrictions").array(),
  dietaryNotes: text("dietary_notes"),
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

/**
 * One row per calendar date of the trip (seeded when the trip is created --
 * see lib/trips.ts's createTrip) -- a fixed 1:1 relationship to the trip's
 * date span, not something the planner adds piecemeal. That makes a gap in
 * the plan ("Day 4 has no lodging yet") visible without extra bookkeeping.
 *
 * Items link here explicitly via items.dayId (see below), not implicitly
 * by matching calendar dates -- an item can be dropped into a day's draft
 * before it has a startsAt at all (see items.dayPosition), so there isn't
 * always a date to match on.
 *
 * Wake/sleep are deliberately independent free-text-plus-geocoded fields,
 * not derived from a lodging item's check-in/check-out — a multi-city trip
 * (Seattle -> ferry to Victoria -> Vancouver -> back to Seattle) often has
 * the day's waking location differ from the prior night's lodging address
 * in ways that aren't worth the timezone-aware date-range matching it'd
 * take to infer reliably. Both, and every tripDayWaypoints row, are null
 * until the planner sets them -- same "not yet analyzed, not a default"
 * posture as everywhere else location data shows up in this app.
 */
export const tripDays = pgTable(
  "trip_days",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    /** YYYY-MM-DD, same convention as trips.startDate/endDate -- no timezone attached. */
    date: text("date").notNull(),
    wakeLocationName: text("wake_location_name"),
    wakeLocationLat: doublePrecision("wake_location_lat"),
    wakeLocationLng: doublePrecision("wake_location_lng"),
    sleepLocationName: text("sleep_location_name"),
    sleepLocationLat: doublePrecision("sleep_location_lat"),
    sleepLocationLng: doublePrecision("sleep_location_lng"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("trip_days_trip_date_idx").on(t.tripId, t.date),
    index("trip_days_trip_idx").on(t.tripId),
  ],
);

/**
 * "Tour destinations" -- zero or more waypoints a day passes through besides
 * where it starts and ends (lunch in one town, dinner in another). Ordered:
 * the Ireland example ("start in one town, lunch in another, dinner in a
 * third") is inherently sequential, even without exact times attached.
 */
export const tripDayWaypoints = pgTable(
  "trip_day_waypoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dayId: uuid("day_id")
      .notNull()
      .references(() => tripDays.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("trip_day_waypoints_day_idx").on(t.dayId)],
);

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

    /**
     * Which of the trip's days this item has been drafted into -- null for
     * an ungrounded idea. Set explicitly (the day-scoped "+ Add" UI) or
     * automatically the moment the item gets a startsAt that lands on one
     * of the trip's own dates (see items.ts's placeInDay). "set null" on
     * delete rather than cascading: losing the day shouldn't destroy the
     * item, just unground it back to an idea.
     */
    dayId: uuid("day_id").references(() => tripDays.id, { onDelete: "set null" }),
    /**
     * Manual order within dayId's draft -- null when dayId is null. Once
     * startsAt is set, this gets resnapped to reflect chronological order
     * among the day's other timed items (see chronoPositionInDay); until
     * then it's purely "where the planner dropped it," maintained via
     * fractional-index midpoint insertion, same technique as
     * tripDayWaypoints.position but without needing to shift every later
     * row on an insert-between.
     */
    dayPosition: doublePrecision("day_position"),

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
    index("items_day_idx").on(t.dayId),
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

export const diningPriceRange = pgEnum("dining_price_range", ["$", "$$", "$$$", "$$$$"]);

/**
 * Same shape as lodgingDetails -- one row per dining item, holding what's
 * specific to a restaurant reservation. Reservation time is the item's own
 * startsAt/endsAt, same reasoning as lodging's check-in/out.
 *
 * accommodates reuses the dietaryTag vocabulary rather than inventing a
 * separate one -- that's what lets conflicts.ts-style logic diff it directly
 * against a trip member's own dietaryRestrictions and raise a warning. A
 * null/empty accommodates means "not analyzed," same as a missing location
 * in the travel-time conflict checker -- it does not mean "accommodates
 * nothing," and must never be treated as a de-facto warning-everyone default.
 *
 * placeId is kept even though nothing queries it yet -- it's what a future
 * LLM-refinement pass re-fetches Place Details from, and what a "View on
 * Google Maps" link would use, without re-running a text search.
 */
export const diningDetails = pgTable("dining_details", {
  itemId: uuid("item_id")
    .primaryKey()
    .references(() => items.id, { onDelete: "cascade" }),
  placeId: text("place_id"),
  cuisine: text("cuisine"),
  accommodates: dietaryTag("accommodates").array(),
  partySize: integer("party_size"),
  priceRange: diningPriceRange("price_range"),
  /** Must be a member of the trip — enforced in lib/dining.ts, not here. */
  reservedBy: uuid("reserved_by").references(() => users.id),
  confirmationNumber: text("confirmation_number"),
  contactPhone: text("contact_phone"),
  reservationUrl: text("reservation_url"),
  specialRequests: text("special_requests"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
