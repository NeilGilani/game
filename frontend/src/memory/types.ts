/**
 * Memory tree types. The contract types come from os/contracts (Instance 1); the rest are the
 * additive endpoints documented in os/memory/INTEGRATION_REQUEST.md.
 */
import type {
  MemoryNode,
  MemoryNodeKind,
  SelectionEvent,
  Suggestion,
  Surface,
} from "../../../os/contracts/src/memory";

export type { MemoryNode, MemoryNodeKind, SelectionEvent, Suggestion, Surface };

/** A tree node as the coordinator returns it: the contract plus inherited flags. */
export interface TreeNode extends MemoryNode {
  effectiveSensitive: boolean;
  effectiveHidden: boolean;
  /** Private mode is on and this is sensitive: label and details are withheld. */
  masked?: boolean;
}

export interface NodeDetail extends TreeNode {
  path: string[];
  children: number;
  timesChosen: number;
  lastChosenAt: string | null;
  fromSetup: boolean;
  reason: string | null;
  usual: Suggestion | null;
}

export interface MemorySettings {
  halfLifeDays: number;
  privateMode: boolean;
  learningPaused: boolean;
  summariesEnabled: boolean;
  usualWindow: number;
  usualMin: number;
  timezone: string | null;
}

export interface EncryptionStatus {
  enabled: boolean;
  keyStore: string | null;
  available: boolean;
  locked: string | null;
}

export interface Grant {
  id: string;
  caregiver: string;
  scope: "everyday" | "everything";
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface AccessEntry {
  caregiver: string;
  at: string;
  what: string;
}

export interface Overview {
  counts: { nodes: number; events: number; notes: number };
  settings: MemorySettings;
  encryption: EncryptionStatus;
  grants: Grant[];
  recentAccess: AccessEntry[];
}

export interface SummaryPreview {
  enabled: boolean;
  available: boolean;
  destination: string;
  facts: string[];
  factsHash: string;
  excluded: string;
}

export interface Note {
  id: string;
  text: string;
  createdAt: string;
}

export interface RecordResult {
  stored: boolean;
  nodeId?: string;
  dropped?: string[];
  reason?: string;
}

export interface ChoiceQuestionLike {
  id: string;
  prompt: string;
  options: { id: string; label: string }[];
}

export interface Prefill {
  questionId: string;
  optionId: string;
  score: number;
  reason: string;
}
