import { create } from 'zustand';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import type { CoreBox } from '../types/core-box';

export interface BoxInput {
  boxNo: string;
  holeId: string;
  fromDepth: number;
  toDepth: number;
  slots: number;
  slotLength: number;
  boxedAt: string;
  shelfPos: string;
  damagedSlots: number[];
  operator: string;
  remark?: string;
}

interface BoxState {
  boxes: CoreBox[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addBox: (input: BoxInput) => Promise<CoreBox>;
  updateBox: (id: string, patch: Partial<BoxInput>) => Promise<void>;
  removeBox: (id: string) => Promise<void>;
}

/** 由登记表单构造岩芯箱实体并打上版本戳（编目台直录与离线队列共用） */
export function buildBoxEntity(input: BoxInput, id: string, rev: number): CoreBox {
  return {
    id,
    boxNo: input.boxNo.trim(),
    holeId: input.holeId,
    fromDepth: Number(input.fromDepth) || 0,
    toDepth: Number(input.toDepth) || 0,
    slots: Number(input.slots) || 0,
    slotLength: Number(input.slotLength) || 0,
    boxedAt: input.boxedAt,
    shelfPos: input.shelfPos,
    damagedSlots: input.damagedSlots ?? [],
    operator: input.operator.trim(),
    remark: input.remark?.trim() || undefined,
    updatedAt: new Date().toISOString(),
    rev,
  };
}

/** 岩芯箱与格位分配 */
export const useBoxStore = create<BoxState>()((set, get) => ({
  boxes: [],
  hydrated: false,

  hydrate: async () => {
    const boxes = await db.boxes.orderBy('boxNo').toArray();
    set({ boxes, hydrated: true });
  },

  addBox: async (input) => {
    const box = buildBoxEntity(input, uid('box'), 1);
    await db.boxes.put(box);
    set({ boxes: [...get().boxes, box] });
    return box;
  },

  updateBox: async (id, patch) => {
    const current = get().boxes.find((b) => b.id === id);
    if (!current) return;
    const next: CoreBox = { ...current, ...patch, updatedAt: new Date().toISOString(), rev: current.rev + 1 };
    await db.boxes.put(next);
    set({ boxes: get().boxes.map((b) => (b.id === id ? next : b)) });
  },

  removeBox: async (id) => {
    await db.boxes.delete(id);
    set({ boxes: get().boxes.filter((b) => b.id !== id) });
  },
}));
