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
  };
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
