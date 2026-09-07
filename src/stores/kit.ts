/**
 * The 16-slot tray (SPEC §7.7).
 *
 * "The tray is the shortlist. The workflow it's built for: audition 40 kicks,
 * put the best 3 in slots, A/B them against the loop, keep one."
 *
 * Slots hold a sample id and a copy of the row for display. Nothing is copied
 * on disk until export.
 */
import { create } from "zustand";

import * as ipc from "../ipc/commands";
import type { KitSummary, SampleRow } from "../ipc/commands";
import { previewSample } from "../audio/preview";
import { previewGainDb } from "../audio/gain";
import { useLibrary } from "./library";

/** Sitala's grid, and therefore ours. */
export const SLOT_COUNT = 16;

export interface Slot {
  sample: SampleRow | null;
  gainDbOffset: number;
}

const emptySlots = (): Slot[] =>
  Array.from({ length: SLOT_COUNT }, () => ({ sample: null, gainDbOffset: 0 }));

interface KitState {
  name: string;
  /** Set once saved or loaded, so a re-save updates rather than duplicates. */
  kitId: number | null;
  slots: Slot[];
  dirty: boolean;
  kits: KitSummary[];
  selectedSlot: number | null;
  error: string | null;

  setName: (name: string) => void;
  assign: (slotIndex: number, sample: SampleRow) => void;
  assignToNextEmpty: (sample: SampleRow) => number | null;
  clearSlot: (slotIndex: number) => void;
  swap: (a: number, b: number) => void;
  setSlotGain: (slotIndex: number, db: number) => void;
  selectSlot: (slotIndex: number) => void;
  clearAll: () => void;

  refreshKits: () => Promise<void>;
  save: () => Promise<void>;
  load: (id: number) => Promise<void>;
  remove: (id: number) => Promise<void>;
}

export const useKit = create<KitState>((set, get) => ({
  name: "Untitled kit",
  kitId: null,
  slots: emptySlots(),
  dirty: false,
  kits: [],
  selectedSlot: null,
  error: null,

  setName: (name) => set({ name, dirty: true }),

  assign: (slotIndex, sample) => {
    if (slotIndex < 0 || slotIndex >= SLOT_COUNT) return;
    set((s) => {
      const slots = [...s.slots];
      // Assigning keeps the slot's existing gain: the offset is a property of
      // the pad's place in the kit, not of whatever sample is in it right now.
      const existing = slots[slotIndex];
      slots[slotIndex] = { sample, gainDbOffset: existing?.gainDbOffset ?? 0 };
      return { slots, dirty: true, selectedSlot: slotIndex };
    });
  },

  assignToNextEmpty: (sample) => {
    const index = get().slots.findIndex((slot) => slot.sample === null);
    if (index === -1) return null;
    get().assign(index, sample);
    return index;
  },

  clearSlot: (slotIndex) =>
    set((s) => {
      const slots = [...s.slots];
      slots[slotIndex] = { sample: null, gainDbOffset: 0 };
      return { slots, dirty: true };
    }),

  swap: (a, b) =>
    set((s) => {
      if (a === b) return {};
      const slots = [...s.slots];
      const first = slots[a];
      const second = slots[b];
      if (first === undefined || second === undefined) return {};
      slots[a] = second;
      slots[b] = first;
      return { slots, dirty: true, selectedSlot: b };
    }),

  setSlotGain: (slotIndex, db) =>
    set((s) => {
      const slots = [...s.slots];
      const existing = slots[slotIndex];
      if (existing === undefined) return {};
      slots[slotIndex] = { ...existing, gainDbOffset: db };
      return { slots, dirty: true };
    }),

  selectSlot: (slotIndex) => {
    const slot = get().slots[slotIndex];
    set({ selectedSlot: slotIndex });
    if (slot?.sample == null) return;
    // A pad previews at the same level it would export at: the library's
    // normalisation plus this pad's offset. Otherwise A/B-ing pads against
    // each other measures the wrong thing.
    const { normalize } = useLibrary.getState();
    void previewSample(slot.sample.id, previewGainDb(slot.sample, normalize) + slot.gainDbOffset);
  },

  clearAll: () =>
    set({ slots: emptySlots(), dirty: true, kitId: null, selectedSlot: null }),

  refreshKits: async () => {
    try {
      set({ kits: await ipc.listKits() });
    } catch (e) {
      set({ error: ipc.errorText(e) });
    }
  },

  save: async () => {
    const { name, slots } = get();
    try {
      const id = await ipc.saveKit(
        name,
        slots.map((slot, slotIndex) => ({
          slotIndex,
          sampleId: slot.sample?.id ?? null,
          gainDbOffset: slot.gainDbOffset,
          notes: null,
        })),
      );
      set({ kitId: id, dirty: false, error: null });
      await get().refreshKits();
    } catch (e) {
      set({ error: ipc.errorText(e) });
    }
  },

  load: async (id) => {
    try {
      const kit = await ipc.loadKit(id);
      if (kit === null) return;
      const slots = emptySlots();
      for (const entry of kit.slots) {
        const target = slots[entry.slotIndex];
        if (target === undefined) continue;
        // A sample the scan has marked removed still comes back, so the pad can
        // show what it lost rather than appearing never to have been filled.
        target.sample = entry.sample;
        target.gainDbOffset = entry.gainDbOffset;
      }
      set({ kitId: kit.id, name: kit.name, slots, dirty: false, error: null });
    } catch (e) {
      set({ error: ipc.errorText(e) });
    }
  },

  remove: async (id) => {
    try {
      await ipc.deleteKit(id);
      if (get().kitId === id) set({ kitId: null, dirty: true });
      await get().refreshKits();
    } catch (e) {
      set({ error: ipc.errorText(e) });
    }
  },
}));
