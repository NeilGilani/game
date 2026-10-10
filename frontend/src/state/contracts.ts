/**
 * The shared OS contracts (os/contracts, owned by Instance 1), re-exported for the interface. Type-only: nothing
 * from os/ is bundled. When the workspace setup lands this becomes `from "@agency/contracts"`.
 */
export type {
  AgentCommand,
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  ChoiceOption,
  ChoiceQuestion,
  ConsequentialKind,
  PlanStepView,
  RiskLevel,
  TaskRequest,
} from "../../../os/contracts/src/agent";
export type { MemoryNode, SelectionEvent, Suggestion, Surface } from "../../../os/contracts/src/memory";
export type {
  AppInfo,
  PermissionKind,
  PermissionState,
  PermissionStatus,
} from "../../../os/contracts/src/native";
