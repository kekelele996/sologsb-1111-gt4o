import type { NodeInfo, NodeRole } from './types';

/** 节点身份管理：每个角色（现场平板 / 地质组台）各持一个持久身份，对应独立 IndexedDB 库 */

const STORAGE_KEY = 'gbdrillcore-node';
const PEERS_KEY = 'gbdrillcore-peer-nodes';

export const ROLE_LABEL: Record<NodeRole, string> = {
  field: '现场班组平板',
  desk: '地质组编目台',
};

function randomId(role: NodeRole): string {
  return `${role}-${Math.random().toString(36).slice(2, 8)}`;
}

function createNode(role: NodeRole): NodeInfo {
  return { nodeId: randomId(role), role, label: ROLE_LABEL[role] };
}

function readStored(): NodeInfo | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<NodeInfo>;
    if (parsed && typeof parsed.nodeId === 'string' && (parsed.role === 'field' || parsed.role === 'desk')) {
      return { nodeId: parsed.nodeId, role: parsed.role, label: ROLE_LABEL[parsed.role] };
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** 取当前节点身份：URL 参数 ?node=xxx 优先（用于打开对端设备窗口），否则读 localStorage */
export function getCurrentNode(): NodeInfo {
  try {
    const url = new URL(window.location.href);
    const urlNode = url.searchParams.get('node');
    if (urlNode) {
      const role: NodeRole = urlNode.startsWith('field') ? 'field' : 'desk';
      return { nodeId: urlNode, role, label: ROLE_LABEL[role] };
    }
  } catch {
    /* ignore */
  }
  const stored = readStored();
    if (stored) return stored;
  const node = createNode('desk');
  localStorage.setItem(STORAGE_KEY, JSON.stringify(node));
  return node;
}

/** 取（或创建）指定角色的持久身份 */
export function getPeerNode(role: NodeRole): NodeInfo {
  try {
    const peersRaw = localStorage.getItem(PEERS_KEY);
    const peers: Partial<Record<NodeRole, NodeInfo>> = peersRaw ? JSON.parse(peersRaw) : {};
    if (peers[role]) return peers[role]!;
    const node = createNode(role);
    peers[role] = node;
    localStorage.setItem(PEERS_KEY, JSON.stringify(peers));
    return node;
  } catch {
    return createNode(role);
  }
}

/** 切换当前角色（返回新身份），并清掉 URL 上的 node 参数避免覆盖 */
export function switchRole(role: NodeRole): NodeInfo {
  const node = getPeerNode(role);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(node));
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('node');
    window.history.replaceState({}, '', url.toString());
  } catch {
    /* ignore */
  }
  return node;
}

/** 打开对端设备窗口（独立标签页、独立 IndexedDB 库，通过 BroadcastChannel 同步） */
export function openPeerWindow(role: NodeRole): void {
  const node = getPeerNode(role);
  const url = new URL(window.location.href);
  url.searchParams.set('node', node.nodeId);
  window.open(url.toString(), '_blank');
}
