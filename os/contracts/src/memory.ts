/**
 * The memory tree (backend/agency/memory), over HTTP on the coordinator:
 *   POST   /api/memory/events                 SelectionEvent
 *   GET    /api/memory/suggestions?surface=home&limit=6   -> Suggestion[]
 *   GET    /api/memory/usual?path=food/delivery            -> Suggestion | null
 *   GET    /api/memory/tree                   -> MemoryNode[]
 *   PATCH  /api/memory/nodes/{id}             { label?, pinned?, hidden? }
 *   DELETE /api/memory/nodes/{id}             forget a node and its events
 *   POST   /api/memory/forget-all             erase everything (confirmed in the UI)
 *   GET    /api/memory/export                 everything, as JSON
 */

export type MemoryNodeKind = "area" | "routine" | "task" | "choice" | "entity" | "phrase";

export interface MemoryNode {
  id: string;
  kind: MemoryNodeKind;
  label: string;
  parentId: string | null;
  /** e.g. { restaurant: "Thai Basil", spice: "mild" } */
  attributes: Record<string, string>;
  pinned: boolean;
  hidden: boolean;
  /** Health, money, relationships: never suggested in front of others when private mode is on. */
  sensitive: boolean;
  createdAt: string;
  updatedAt: string;
}

export type Surface = "home" | "food" | "call" | "talk" | "keyboard" | "papers" | "shopping" | "apps" | "browse";

export interface SelectionEvent {
  /** Path from the root, e.g. ["food", "delivery", "Thai Basil", "Pad thai (mild)"]. */
  path: string[];
  surface: Surface;
  outcome: "chosen" | "rejected" | "completed" | "abandoned";
  /** Filled by the server from its clock when omitted. */
  at?: string;
  attributes?: Record<string, string>;
}

export interface Suggestion {
  nodeId: string;
  path: string[];
  label: string;
  /** 0..1 */
  score: number;
  /** Plain language, from recorded facts: "You chose this 4 of the last 5 Fridays." */
  reason: string;
  /** What starting it would do, if it maps to a task. */
  task?: { goal: string; selections: Record<string, string> };
}
