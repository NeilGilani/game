import type { BridgeApi } from "../src/app/server.ts";
import type { TreeNode } from "../src/protocol.ts";

/** Reads the page and returns the first node matching role and (exact or partial) name. */
export async function find(
  bridge: BridgeApi,
  tabId: number,
  role: string,
  name: string | RegExp,
): Promise<TreeNode> {
  const tree = await bridge.call("page.tree", { tabId });
  const hit = tree.data.nodes.find(
    (n) => n.role === role && (typeof name === "string" ? n.name === name : name.test(n.name)),
  );
  if (!hit) {
    const seen = tree.data.nodes
      .filter((n) => n.role === role)
      .map((n) => n.name)
      .join(" | ");
    throw new Error(`No ${role} named ${String(name)} on ${tree.data.url}. Seen: ${seen}`);
  }
  return hit;
}

export async function clickByName(bridge: BridgeApi, tabId: number, role: string, name: string | RegExp) {
  const n = await find(bridge, tabId, role, name);
  return bridge.call("page.click", { tabId, ref: n.ref });
}
