/**
 * An in-memory MemoryApi for tests and demos without a coordinator. It keeps the same shapes and
 * rules (hidden, pinned, private mode, forget) but learns by plain counting, and its reasons say
 * exactly that ("You chose this 3 times."). The real learner lives in backend/agency/memory.
 */
import type { MemoryApi } from "./api";
import type {
  Grant,
  MemoryNodeKind,
  MemorySettings,
  Note,
  NodeDetail,
  SelectionEvent,
  Suggestion,
  Surface,
  TreeNode,
} from "./types";

const SENSITIVE =
  /\b(health|medical|medicine|medication|pharmacy|doctor|clinic|hospital|therapy|bank|money|bills?|payment|insurance|benefits|tax|relationship|partner|private)\b/i;
const SECRET_KEY = /pass(word|code)?|otp|2fa|cvv|cvc|card[-_ ]?(number|no)|^pin$|ssn|secret|token/i;
const DEFAULT_SETTINGS: MemorySettings = {
  halfLifeDays: 30,
  privateMode: false,
  learningPaused: false,
  summariesEnabled: false,
  usualWindow: 5,
  usualMin: 3,
  timezone: null,
};

interface FakeEvent {
  pathIds: string[];
  surface: string;
  outcome: SelectionEvent["outcome"];
  at: string;
  attributes: Record<string, string>;
}

const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

export class FakeMemoryApi implements MemoryApi {
  nodes = new Map<string, TreeNode>();
  events: FakeEvent[] = [];
  notesList: Note[] = [];
  grantList: Grant[] = [];
  current: MemorySettings = { ...DEFAULT_SETTINGS };
  private seq = 0;

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly summarizer: (facts: string[]) => string[] = (facts) => facts.map((f) => `Noted: ${f}`),
  ) {}

  /** Convenience for tests and demos: record several selections at once. */
  async seed(events: SelectionEvent[]): Promise<void> {
    for (const e of events) await this.record(e);
  }

  private key(parentId: string | null, label: string) {
    return `${parentId ?? ""}\u001f${label.toLocaleLowerCase().split(/\s+/).join(" ")}`;
  }

  private chain(id: string): TreeNode[] {
    const out: TreeNode[] = [];
    let node = this.nodes.get(id);
    while (node) {
      out.unshift(node);
      node = node.parentId ? this.nodes.get(node.parentId) : undefined;
    }
    return out;
  }

  private flags(id: string) {
    const chain = this.chain(id);
    return { hidden: chain.some((n) => n.hidden), sensitive: chain.some((n) => n.sensitive) };
  }

  private visible(id: string) {
    const f = this.flags(id);
    return !f.hidden && !(f.sensitive && this.current.privateMode);
  }

  private view(node: TreeNode, reveal = false): TreeNode {
    const f = this.flags(node.id);
    const item: TreeNode = {
      ...node,
      attributes: { ...node.attributes },
      effectiveHidden: f.hidden,
      effectiveSensitive: f.sensitive,
    };
    if (f.sensitive && this.current.privateMode && !reveal)
      return { ...item, label: "Private", attributes: {}, masked: true };
    return item;
  }

  private find(path: string[]): TreeNode | null {
    let parent: string | null = null;
    let found: TreeNode | null = null;
    for (const label of path) {
      found =
        [...this.nodes.values()].find((n) => this.key(n.parentId, n.label) === this.key(parent, label)) ??
        null;
      if (!found) return null;
      parent = found.id;
    }
    return found;
  }

  private ensure(path: string[], surface: string, attributes: Record<string, string>): string[] {
    const ids: string[] = [];
    let parent: string | null = null;
    const stamp = this.now().toISOString();
    path.forEach((label, depth) => {
      const leaf = depth === path.length - 1;
      let node = [...this.nodes.values()].find(
        (n) => n.parentId === parent && this.key(n.parentId, n.label) === this.key(parent, label),
      );
      if (!node) {
        const kind: MemoryNodeKind =
          depth === 0
            ? "area"
            : leaf
              ? surface === "talk" || surface === "keyboard"
                ? "phrase"
                : "choice"
              : depth === 1
                ? "routine"
                : "task";
        node = {
          id: `fake_${++this.seq}`,
          kind,
          label,
          parentId: parent,
          attributes: leaf ? { ...attributes } : {},
          pinned: false,
          hidden: false,
          sensitive: SENSITIVE.test(label),
          createdAt: stamp,
          updatedAt: stamp,
          effectiveHidden: false,
          effectiveSensitive: false,
        };
        this.nodes.set(node.id, node);
      } else if (leaf) {
        node.attributes = { ...node.attributes, ...attributes };
      }
      ids.push(node.id);
      parent = node.id;
    });
    return ids;
  }

  async record(event: SelectionEvent) {
    if (this.current.learningPaused)
      return { stored: false, reason: "Learning is paused. Nothing was saved." };
    const attributes: Record<string, string> = {};
    const dropped: string[] = [];
    for (const [k, v] of Object.entries(event.attributes ?? {})) {
      if (SECRET_KEY.test(k)) dropped.push(k);
      else attributes[k] = v;
    }
    const pathIds = this.ensure(event.path, event.surface, attributes);
    this.events.push({
      pathIds,
      surface: event.surface,
      outcome: event.outcome,
      at: event.at ?? this.now().toISOString(),
      attributes,
    });
    return { stored: true, nodeId: pathIds[pathIds.length - 1], dropped };
  }

  private chosen(filter: (e: FakeEvent) => boolean) {
    return this.events.filter((e) => (e.outcome === "chosen" || e.outcome === "completed") && filter(e));
  }

  private suggestion(id: string, score: number, reason: string): Suggestion {
    const chain = this.chain(id);
    const node = chain[chain.length - 1]!;
    return {
      nodeId: id,
      path: chain.map((n) => n.label),
      label: node.label,
      score,
      reason: node.pinned ? `You pinned this. ${reason}` : reason,
    };
  }

  async suggestions(surface: Surface, limit = 6, prefix?: string) {
    const counts = new Map<string, number>();
    for (const e of this.chosen(
      (e) => e.surface === surface || (surface === "home" && e.surface !== "keyboard"),
    )) {
      const leaf = e.pathIds[e.pathIds.length - 1]!;
      counts.set(leaf, (counts.get(leaf) ?? 0) + 1);
    }
    const total = [...counts.values()].reduce((a, b) => a + b, 0) || 1;
    return [...counts.entries()]
      .filter(([id]) => this.nodes.has(id) && this.visible(id))
      .filter(([id]) => !prefix || this.nodes.get(id)!.label.toLowerCase().startsWith(prefix.toLowerCase()))
      .sort(
        (a, b) => Number(this.nodes.get(b[0])!.pinned) - Number(this.nodes.get(a[0])!.pinned) || b[1] - a[1],
      )
      .slice(0, limit)
      .map(([id, n]) =>
        this.suggestion(id, Math.round((n / total) * 1000) / 1000, `You chose this ${times(n)}.`),
      );
  }

  async usual(path: string[]) {
    const root = this.find(path);
    if (!root) return null;
    const recent = this.chosen((e) => e.pathIds.includes(root.id)).slice(-this.current.usualWindow);
    const counts = new Map<string, number>();
    for (const e of recent)
      counts.set(e.pathIds[e.pathIds.length - 1]!, (counts.get(e.pathIds[e.pathIds.length - 1]!) ?? 0) + 1);
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!best || recent.length < 4 || best[1] < this.current.usualMin || !this.visible(best[0])) return null;
    return this.suggestion(
      best[0],
      best[1] / recent.length,
      `You chose this ${best[1]} of the last ${recent.length} times.`,
    );
  }

  async tree(reveal = false) {
    return [...this.nodes.values()].map((n) => this.view(n, reveal));
  }

  async node(id: string, reveal = false): Promise<NodeDetail> {
    const node = this.nodes.get(id);
    if (!node) throw new Error("AGENCY doesn't know that (it may have been forgotten).");
    const view = this.view(node, reveal);
    const mine = this.chosen((e) => e.pathIds.includes(id));
    const children = [...this.nodes.values()].filter((n) => n.parentId === id).length;
    const usual =
      node.kind === "choice" || node.kind === "phrase"
        ? null
        : await this.usual(this.chain(id).map((n) => n.label));
    return {
      ...view,
      path: view.masked ? ["Private"] : this.chain(id).map((n) => n.label),
      children,
      timesChosen: mine.length,
      lastChosenAt: mine.length ? mine[mine.length - 1]!.at : null,
      fromSetup: false,
      reason: view.masked || !mine.length ? null : `You chose this ${times(mine.length)}.`,
      usual: view.masked ? null : usual,
    };
  }

  async patch(
    id: string,
    patch: { label?: string; pinned?: boolean; hidden?: boolean; sensitive?: boolean },
  ) {
    const node = this.nodes.get(id);
    if (!node) throw new Error("AGENCY doesn't know that (it may have been forgotten).");
    Object.assign(node, patch, { updatedAt: this.now().toISOString() });
    return this.view(node);
  }

  async forget(id: string) {
    const doomed = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of this.nodes.values()) {
        if (n.parentId && doomed.has(n.parentId) && !doomed.has(n.id)) {
          doomed.add(n.id);
          grew = true;
        }
      }
    }
    doomed.forEach((d) => this.nodes.delete(d));
    this.events = this.events.filter((e) => !e.pathIds.some((p) => doomed.has(p)));
    return { forgotten: doomed.size };
  }

  async forgetAll() {
    const counts = { nodes: this.nodes.size, events: this.events.length, notes: this.notesList.length };
    this.nodes.clear();
    this.events = [];
    this.notesList = [];
    this.grantList = [];
    return { forgotten: counts };
  }

  async exportAll() {
    return {
      format: "agency-memory-export",
      nodes: [...this.nodes.values()],
      events: this.events,
      notes: this.notesList,
      settings: this.current,
    };
  }

  async overview() {
    const stamp = this.now().toISOString();
    return {
      counts: { nodes: this.nodes.size, events: this.events.length, notes: this.notesList.length },
      settings: { ...this.current },
      encryption: { enabled: false, keyStore: null, available: false, locked: null },
      grants: this.grantList.filter((g) => !g.revokedAt && g.expiresAt > stamp),
      recentAccess: [],
    };
  }

  async settings() {
    return { ...this.current };
  }

  async saveSettings(settings: MemorySettings) {
    this.current = { ...settings };
    return { ...this.current };
  }

  async setEncryption(): Promise<never> {
    throw new Error("Encryption isn't available in the fake.");
  }

  async prefill() {
    return null;
  }

  private facts() {
    const counts = new Map<string, number>();
    for (const e of this.chosen(() => true))
      counts.set(e.pathIds[e.pathIds.length - 1]!, (counts.get(e.pathIds[e.pathIds.length - 1]!) ?? 0) + 1);
    return [...counts.entries()]
      .filter(
        ([id, n]) => n >= 2 && this.nodes.has(id) && !this.flags(id).hidden && !this.flags(id).sensitive,
      )
      .map(
        ([id, n]) =>
          `${this.chain(id)
            .map((x) => x.label)
            .join(" > ")}: chosen ${n} times`,
      );
  }

  async summaryPreview() {
    const facts = this.facts();
    return {
      enabled: this.current.summariesEnabled,
      available: true,
      destination: "Anthropic API (fake)",
      facts,
      factsHash: String(facts.join("\n").length).padStart(64, "0"),
      excluded: "Sensitive and hidden items, and everything chosen fewer than twice, are never sent.",
    };
  }

  async summarize(factsHash: string) {
    const preview = await this.summaryPreview();
    if (!this.current.summariesEnabled)
      throw new Error("Summaries are off. Turn them on in memory settings first.");
    if (preview.factsHash !== factsHash)
      throw new Error("What would be sent has changed. Please look at it again before sending.");
    const notes = this.summarizer(preview.facts).map((text) => ({
      id: `note_${++this.seq}`,
      text,
      createdAt: this.now().toISOString(),
    }));
    this.notesList.push(...notes);
    return { notes };
  }

  async notes() {
    return [...this.notesList];
  }

  async deleteNote(id: string) {
    this.notesList = this.notesList.filter((n) => n.id !== id);
    return { deleted: id };
  }

  async grants() {
    return [...this.grantList];
  }

  async grant(caregiver: string, scope: Grant["scope"], days: number) {
    const now = this.now();
    const grant: Grant = {
      id: `grant_${++this.seq}`,
      caregiver,
      scope,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + days * 86_400_000).toISOString(),
      revokedAt: null,
    };
    this.grantList.push(grant);
    return { ...grant, token: `fake-token-${this.seq}` };
  }

  async revoke(id: string) {
    const grant = this.grantList.find((g) => g.id === id);
    if (!grant || grant.revokedAt) throw new Error("That access was already ended or doesn't exist.");
    grant.revokedAt = this.now().toISOString();
    return { ...grant };
  }
}
