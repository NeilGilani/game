/**
 * Everything that "happened" in the sandbox web world. Tests, evals and demos read it through the test
 * API (GET /__test/state) to check outcomes instead of trusting what an agent says.
 */

export interface SandboxEvent {
  at: string;
  site: string;
  type: string;
  data: Record<string, unknown>;
}

export interface CartLine {
  lineId: number;
  itemId: string;
  name: string;
  options: string[];
  qty: number;
  unitCents: number;
  note: string;
}

export interface FoodOrder {
  id: string;
  restaurantId: string;
  restaurant: string;
  lines: CartLine[];
  subtotalCents: number;
  deliveryFeeCents: number;
  serviceFeeCents: number;
  taxCents: number;
  tipCents: number;
  totalCents: number;
  address: string;
  payment: string;
  instructions: string;
  placedAt: number;
  cancelled: boolean;
  /** Minutes added by the test API to move tracking forward. */
  advancedSteps: number;
}

export interface World {
  events: SandboxEvent[];
  food: {
    cart: { restaurantId: string | null; lines: CartLine[]; nextLine: number };
    tipPercent: number | null;
    tipCustomCents: number;
    addressId: string;
    orders: FoodOrder[];
    priceOverrides: Record<string, number>;
    nextOrder: number;
    /** Test knob: a "DashDish Plus" trial is switched on at checkout. */
    plusOn: boolean;
  };
  shop: ShopState;
  pharmacy: {
    refills: Array<Record<string, unknown>>;
    doctorRequests: Array<Record<string, unknown>>;
    pending: string[] | null;
    method: string;
    store: string;
  };
  benefits: {
    draft: Record<string, string>;
    submissions: Array<Record<string, string> & { reference: string }>;
  };
  mail: {
    sent: Array<{ id: string; to: string; cc: string; subject: string; body: string; at: string }>;
    deleted: string[];
    read: string[];
  };
  clinic: { bookings: Array<Record<string, string>> };
  inject: { canaries: Array<Record<string, unknown>> };
  flaky: { attempts: Record<string, number> };
  bank: { signedIn: boolean; transfers: Array<Record<string, unknown>> };
}

export interface ShopLine {
  productId: string;
  name: string;
  qty: number;
  unitCents: number;
  subscribe: boolean;
}

export interface ShopState {
  cart: ShopLine[];
  orders: Array<{
    id: string;
    lines: ShopLine[];
    subtotalCents: number;
    shippingCents: number;
    taxCents: number;
    totalCents: number;
    address: string;
    payment: string;
    placedAt: number;
  }>;
  /** Repeat deliveries someone signed up for (Subscribe & Save). */
  subscriptions: Array<{ productId: string; every: string }>;
  /** Joined the ShopMart Plus trial. */
  plusMember: boolean;
  priceOverrides: Record<string, number>;
  nextOrder: number;
  // Test knobs (POST /__test/shop/flags):
  /** Every page asks to sign in. */
  signedOut: boolean;
  /** Checkout asks for the card's security code again. */
  askCvv: boolean;
  /** The Plus trial box is ticked at checkout. */
  plusOnAtCheckout: boolean;
  /** Subscribe & Save is the chosen way to buy on product pages. */
  subscribeDefault: boolean;
}

export function newWorld(): World {
  return {
    events: [],
    food: {
      cart: { restaurantId: null, lines: [], nextLine: 1 },
      tipPercent: 15,
      tipCustomCents: 0,
      addressId: "home",
      orders: [],
      priceOverrides: {},
      nextOrder: 1001,
      plusOn: false,
    },
    shop: {
      cart: [],
      orders: [],
      subscriptions: [],
      plusMember: false,
      priceOverrides: {},
      nextOrder: 2001,
      signedOut: false,
      askCvv: false,
      plusOnAtCheckout: false,
      subscribeDefault: false,
    },
    pharmacy: { refills: [], doctorRequests: [], pending: null, method: "pickup", store: "elm" },
    benefits: { draft: {}, submissions: [] },
    mail: { sent: [], deleted: [], read: [] },
    clinic: { bookings: [] },
    inject: { canaries: [] },
    flaky: { attempts: {} },
    bank: { signedIn: false, transfers: [] },
  };
}

export function record(w: World, site: string, type: string, data: Record<string, unknown>): void {
  w.events.push({ at: new Date().toISOString(), site, type, data });
}
