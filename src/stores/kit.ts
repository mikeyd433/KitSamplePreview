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
  /** Varispeed offset for the chromatic spread. 0 is the sample as recorded. */
  semitones: number;
}

const emptySlots = (): Slot[] =>
  Array.from({ length: SLOT_COUNT }, () => ({
    sample: null,
    gainDbOffset: 0,
    semitones: 0,
  }));

/** Two octaves either way, matching `pitch::MIN_SEMITONES` / `MAX_SEMITONES`. */
export const MIN_SEMITONES = -24;
export const MAX_SEMITONES = 24;

export interface SpreadOptions {
  /** Semitone offset of pad 1. Shifts the whole range without changing its shape. */
  root: number;
  /** Semitones between one pad and the next. 1 is chromatic, 12 is octaves. */
  step: number;
}

export const DEFAULT_SPREAD: SpreadOptions = { root: 0, step: 1 };

export type PadMode = "assign" | "play";

/**
 * The offset for each pad of a spread, clamped to the render's range.
 *
 * Clamping rather than refusing: a step of 4 from a root of 0 runs off the top
 * at pad 13, and silently dropping the last four pads would be worse than
 * filling them at the ceiling, where at least the shape of the problem is
 * audible.
 */
export function spreadSemitones(options: SpreadOptions): number[] {
  return Array.from({ length: SLOT_COUNT }, (_, i) =>
    Math.min(MAX_SEMITONES, Math.max(MIN_SEMITONES, options.root + i * options.step)),
  );
}

interface KitState {
  name: string;
  /** Set once saved or loaded, so a re-save updates rather than duplicates. */
  kitId: number | null;
  slots: Slot[];
  dirty: boolean;
  kits: KitSummary[];
  selectedSlot: number | null;
  error: string | null;
  /**
   * Pitched pads whose file has not been rendered yet.
   *
   * A pitch that exists only as a playback rate cannot be dragged, so the
   * spread renders all sixteen up front and the tray says so while it does.
   * Rendering inside the drag gesture instead would mean the mouse button is
   * already down while a file is being written, and a quick flick would drop
   * nothing at all.
   */
  rendering: number;
  /**
   * What the sixteen pad keys do.
   *
   * "assign" is SPEC §7.2's behaviour: press `1` to put the selected sample on
   * pad 1, which is how a shortlist gets built. A chromatic spread needs the
   * opposite -- the pads are already full and the keys are an instrument -- so
   * the two cannot share one key. Switching is explicit rather than inferred
   * from whether the pads happen to be full, because a keymap that changes
   * under you on the sixteenth assignment would be worse than a visible toggle.
   */
  padMode: PadMode;

  setName: (name: string) => void;
  assign: (slotIndex: number, sample: SampleRow) => void;
  assignToNextEmpty: (sample: SampleRow) => number | null;
  clearSlot: (slotIndex: number) => void;
  swap: (a: number, b: number) => void;
  setSlotGain: (slotIndex: number, db: number) => void;
  setSlotSemitones: (slotIndex: number, semitones: number) => void;
  setPadMode: (mode: PadMode) => void;
  /** Renders every pitched pad to a file, so the pads can be dragged. */
  renderPitches: () => Promise<void>;
  /** Fills every pad with one sample, pitched. The piano. */
  spreadChromatic: (sample: SampleRow, options: SpreadOptions) => void;
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
  rendering: 0,
  padMode: "assign",
  error: null,

  setName: (name) => set({ name, dirty: true }),

  assign: (slotIndex, sample) => {
    if (slotIndex < 0 || slotIndex >= SLOT_COUNT) return;
    set((s) => {
      const slots = [...s.slots];
      // Assigning keeps the slot's existing gain: the offset is a property of
      // the pad's place in the kit, not of whatever sample is in it right now.
      const existing = slots[slotIndex];
      // Pitch belongs to the pad too: dropping a new sample onto pad 5 of a
      // chromatic spread keeps pad 5's note, which is the whole point of the
      // grid staying in pitch order.
      slots[slotIndex] = {
        sample,
        gainDbOffset: existing?.gainDbOffset ?? 0,
        semitones: existing?.semitones ?? 0,
      };
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
      slots[slotIndex] = { sample: null, gainDbOffset: 0, semitones: 0 };
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
    void previewSample(
      slot.sample.id,
      previewGainDb(slot.sample, normalize) + slot.gainDbOffset,
      slot.semitones,
    );
  },

  setSlotSemitones: (slotIndex, semitones) => {
    set((s) => {
      const slots = [...s.slots];
      const existing = slots[slotIndex];
      if (existing === undefined) return {};
      const clamped = Math.min(MAX_SEMITONES, Math.max(MIN_SEMITONES, semitones));
      slots[slotIndex] = { ...existing, semitones: clamped };
      return { slots, dirty: true };
    });
    void get().renderPitches();
  },

  /**
   * One sample across all sixteen pads, pitched -- which is what makes Sitala
   * play a bassline off a single 808.
   *
   * Replaces the whole tray rather than filling the empty pads. A spread is a
   * different intent from a shortlist: half a chromatic run interleaved with
   * leftover kicks is not a thing anyone wants, and the pads have to stay in
   * pitch order for the grid to be playable by position.
   */
  spreadChromatic: (sample, options) => {
    const offsets = spreadSemitones(options);
    set({
      slots: offsets.map((semitones) => ({ sample, gainDbOffset: 0, semitones })),
      dirty: true,
      selectedSlot: 0,
      error: null,
      // The pads are now an instrument, so the keys should play them. Leaving
      // them on "assign" would mean the first thing you do after building a
      // piano is overwrite one of its notes.
      padMode: "play",
    });
    void get().renderPitches();
  },

  renderPitches: async () => {
    // Unity pads need nothing rendered -- they drag as the original file.
    const wanted = [
      ...new Set(
        get()
          .slots.flatMap((slot) =>
            slot.sample === null || slot.semitones === 0
              ? []
              : [`${slot.sample.id}:${slot.semitones}`],
          ),
      ),
    ];
    if (wanted.length === 0) return;

    set((s) => ({ rendering: s.rendering + wanted.length }));
    for (const key of wanted) {
      const [id, semitones] = key.split(":");
      try {
        await ipc.renderPitched(Number(id), Number(semitones));
      } catch (e) {
        // One pad that will not render should not stop the other fifteen, and
        // the pad itself reports the failure when it is dragged.
        set({ error: ipc.errorText(e) });
      } finally {
        set((s) => ({ rendering: Math.max(0, s.rendering - 1) }));
      }
    }
  },

  setPadMode: (padMode) => set({ padMode }),

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
          semitones: slot.semitones,
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
        target.semitones = entry.semitones ?? 0;
      }
      set({ kitId: kit.id, name: kit.name, slots, dirty: false, error: null });
      // A saved chromatic kit reopens with pitches but no files: the renders
      // live in a cache that may have been cleared since.
      void get().renderPitches();
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
