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

export const transportSubtype = pgEnum("transport_subtype", [
  "flight",
  "train",
  "drive",
  "rideshare",
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
 * Wake/sleep/stops themselves live in tripDayLocations, not columns here --
 * see that table's own comment for why.
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("trip_days_trip_date_idx").on(t.tripId, t.date),
    index("trip_days_trip_idx").on(t.tripId),
  ],
);

export const dayLocationKind = pgEnum("day_location_kind", ["wake", "sleep", "stop"]);

/**
 * A single place a day touches -- where it wakes up, where it sleeps, or a
 * stop in between ("tour destinations", the Ireland example: start in one
 * town, lunch in another, dinner in a third). Unified into one table,
 * rather than wake/sleep staying columns on tripDays and stops staying
 * their own table, because all three need the exact same two things: a
 * place name to geocode, and a per-location "who's actually there" member
 * list (see tripDayLocationMembers) -- there's no reason to build that
 * member-inclusion mechanism three separate times.
 *
 * Deliberately independent of any lodging item's check-in/check-out — a
 * multi-city trip (Seattle -> ferry to Victoria -> Vancouver -> back to
 * Seattle) often has the day's waking location differ from the prior
 * night's lodging address in ways that aren't worth the timezone-aware
 * date-range matching it'd take to infer reliably.
 *
 * At most one `wake` and one `sleep` row per day -- enforced in days.ts's
 * setWakeLocation/setSleepLocation (an upsert), not a DB constraint.
 * `position` orders `stop` rows relative to each other; wake/sleep ignore
 * it (always 0), since they're pinned first and last, not part of that
 * ordering.
 */
export const tripDayLocations = pgTable(
  "trip_day_locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dayId: uuid("day_id")
      .notNull()
      .references(() => tripDays.id, { onDelete: "cascade" }),
    kind: dayLocationKind("kind").notNull(),
    name: text("name").notNull(),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("trip_day_locations_day_idx").on(t.dayId),
    index("trip_day_locations_day_kind_idx").on(t.dayId, t.kind),
  ],
);

/**
 * Who's actually part of a given location -- lets a split day (Day 1: my
 * brother and mother leave from Bethlehem, PA; I leave from NYC) record
 * that without inventing separate per-person days or trips. A trip
 * member's own "my day" view filters to locations that include them (see
 * the trip page), so everyone sees where *they're* going, not everyone
 * else's leg.
 *
 * Every trip member is included by default the moment a location is
 * created (see days.ts's setWakeLocation/setSleepLocation/addStop) --
 * explicit rows rather than "no rows means everyone," so removing the
 * trip's last included member from a location can't be silently
 * reinterpreted as "back to including everyone."
 */
export const tripDayLocationMembers = pgTable(
  "trip_day_location_members",
  {
    locationId: uuid("location_id")
      .notNull()
      .references(() => tripDayLocations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.locationId, t.userId] }),
    index("trip_day_location_members_user_idx").on(t.userId),
  ],
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

/**
 * Category-specific fields for a transport item, one row per item -- same
 * pattern as lodgingDetails/diningDetails. `subtype` is what lib/transport.ts
 * keys its buffer logic on: a flight needs security-line and bag-claim
 * padding a train doesn't, driving needs a parking allowance, a rideshare
 * needs a pickup-wait buffer instead of a boarding one. See
 * lib/transport.ts's transportBufferFor.
 *
 * The item's own startsAt/endsAt is still the door-to-door span, same
 * reasoning as lodging's check-in/out (see lodgingDetails above) -- for a
 * flight with connections that's the first leg's departure to the last
 * leg's arrival, kept in sync with transportLegs by lib/transport.ts's
 * setTransportLegs rather than edited by hand.
 *
 * `international` only means anything for subtype "flight" -- it widens
 * both the pre-departure buffer (extra check-in/security/customs time) and
 * the minimum layover a connection gets flagged for. Null/false is the
 * domestic default.
 */
export const transportDetails = pgTable("transport_details", {
  itemId: uuid("item_id")
    .primaryKey()
    .references(() => items.id, { onDelete: "cascade" }),
  subtype: transportSubtype("subtype").notNull(),
  international: boolean("international"),
  confirmationNumber: text("confirmation_number"),
  /** Must be a member of the trip — enforced in lib/transport.ts, not here. */
  bookedBy: uuid("booked_by").references(() => users.id),
  bookingUrl: text("booking_url"),
  costAmount: doublePrecision("cost_amount"),
  /** ISO 4217, e.g. "USD" — free text, not validated against a currency list. */
  costCurrency: text("cost_currency"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per leg of a flight's routing -- a nonstop flight has exactly one
 * row, a connecting itinerary has one per segment, ordered by `legOrder`
 * starting at 0. Only meaningful when the parent transportDetails.subtype
 * is "flight"; lib/transport.ts enforces that, not a DB constraint, same
 * division of labor as lodgingDetails.bookedBy.
 *
 * departsAt/arrivesAt are what the item's own startsAt/endsAt get derived
 * from (first leg's departure, last leg's arrival -- see
 * deriveScheduleFromLegs) and what lib/transport.ts's analyzeLegLayovers
 * checks each connection's dwell time against: a layover shorter than the
 * minimum connection time is itself worth flagging, separate from the
 * door-to-door buffer transportBufferFor adds around the whole item.
 *
 * arrivalLat/arrivalLng (geocoded from arrivalAirport when a leg is saved
 * -- see actions.ts's updateTransportLegsAction) are what let the last
 * leg's landing point, not the item's own generic location field, govern
 * travel-time conflict checks against whatever comes after this item: a
 * flight's own `location` is wherever it was set at creation (its
 * departure point, typically), which has nothing to do with where the
 * traveler actually ends up. See conflicts.ts's ScheduleItem.destinationLocation.
 */
export const transportLegs = pgTable(
  "transport_legs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    legOrder: integer("leg_order").notNull(),
    airline: text("airline"),
    flightNumber: text("flight_number"),
    /** Free-text airport code, e.g. "SFO" -- not validated against an IATA list. */
    departureAirport: text("departure_airport"),
    arrivalAirport: text("arrival_airport"),
    /** Null until arrivalAirport is successfully geocoded -- same "unset just means we can't analyze it" degrade as every other optional coordinate lookup in this app. */
    arrivalLat: doublePrecision("arrival_lat"),
    arrivalLng: doublePrecision("arrival_lng"),
    departsAt: timestamp("departs_at", { withTimezone: true }).notNull(),
    arrivesAt: timestamp("arrives_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("transport_legs_item_order_idx").on(t.itemId, t.legOrder),
    index("transport_legs_item_idx").on(t.itemId),
  ],
);
