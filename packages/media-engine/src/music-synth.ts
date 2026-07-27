const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BITS_PER_SAMPLE = 16;

export type LocalMusicTemplateId = "light_tech" | "bright_launch";

interface MusicTemplate {
  bpm: number;
  progression: readonly number[];
  melody: readonly number[];
  groove: readonly (readonly number[])[];
  brightness: number;
}

const TEMPLATES: Record<LocalMusicTemplateId, MusicTemplate> = {
  light_tech: {
    bpm: 98,
    progression: [0, 3, 2, 1],
    melody: [72, 76, 79, 83, 79, 76, 74, 71],
    groove: [
      [0.5, 1.25, 1.75, 2.75, 3.5],
      [0.25, 1, 1.5, 2.25, 3, 3.75],
      [0, 0.75, 1.5, 2.5, 2.75, 3.5],
      [0.5, 1.25, 2, 2.25, 3.25, 3.75],
    ],
    brightness: 0,
  },
  bright_launch: {
    bpm: 108,
    progression: [0, 2, 3, 1],
    melody: [76, 79, 83, 84, 83, 79, 81, 76],
    groove: [
      [0.25, 0.75, 1.5, 2.25, 3, 3.5],
      [0, 1, 1.5, 2.75, 3.25, 3.75],
      [0.25, 1.25, 1.75, 2.25, 3, 3.5, 3.75],
      [0.5, 1, 2, 2.5, 3.25, 3.75],
    ],
    brightness: 1,
  },
};

const CHORDS = [
  [60, 64, 67, 71],
  [55, 59, 62, 64],
  [57, 60, 64, 67],
  [53, 57, 60, 64],
] as const;
const BASS = [48, 55, 57, 53] as const;

function frequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

function panGains(pan: number): [number, number] {
  const value = Math.max(-1, Math.min(1, pan));
  return [Math.sqrt((1 - value) / 2), Math.sqrt((1 + value) / 2)];
}

function addTone(
  left: Float32Array,
  right: Float32Array,
  input: {
    start: number;
    duration: number;
    midi: number;
    gain: number;
    pan: number;
    brightness: number;
    decay: number;
  },
): void {
  const start = Math.max(0, Math.round(input.start * SAMPLE_RATE));
  const count = Math.max(1, Math.round(input.duration * SAMPLE_RATE));
  const end = Math.min(left.length, start + count);
  const hz = frequency(input.midi);
  const [gainL, gainR] = panGains(input.pan);
  for (let frame = start; frame < end; frame += 1) {
    const time = (frame - start) / SAMPLE_RATE;
    const remaining = (end - frame) / SAMPLE_RATE;
    const attack = Math.min(1, time / 0.008);
    const release = Math.min(1, remaining / 0.06);
    const envelope =
      attack * release * Math.exp(-input.decay * (time / input.duration));
    const phase = Math.PI * 2 * hz * time;
    const wave =
      (0.72 - input.brightness * 0.12) * Math.sin(phase) +
      (0.22 + input.brightness * 0.06) * Math.sin(phase * 2 + 0.1) +
      (0.06 + input.brightness * 0.06) * Math.sin(phase * 4 + 0.2);
    const sample = wave * envelope * input.gain;
    left[frame] = left[frame]! + sample * gainL;
    right[frame] = right[frame]! + sample * gainR;
  }
}

function noise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) / 0xffff_ffff) * 2 - 1;
  };
}

function addDrum(
  left: Float32Array,
  right: Float32Array,
  input: {
    start: number;
    kind: "kick" | "snare" | "hat";
    gain: number;
    seed: number;
    pan?: number;
  },
): void {
  const duration =
    input.kind === "kick" ? 0.24 : input.kind === "snare" ? 0.18 : 0.08;
  const start = Math.max(0, Math.round(input.start * SAMPLE_RATE));
  const end = Math.min(left.length, start + Math.round(duration * SAMPLE_RATE));
  const random = noise(input.seed);
  const [gainL, gainR] = panGains(input.pan ?? 0);
  let phase = 0;
  let previous = 0;
  for (let frame = start; frame < end; frame += 1) {
    const time = (frame - start) / SAMPLE_RATE;
    let sample: number;
    if (input.kind === "kick") {
      const hz = 50 + 82 * Math.exp(-time * 25);
      phase += (Math.PI * 2 * hz) / SAMPLE_RATE;
      sample = Math.sin(phase) * Math.exp(-time * 29);
    } else {
      const value = random();
      const high = value - previous * (input.kind === "hat" ? 0.92 : 0.55);
      previous = value;
      const body =
        input.kind === "snare"
          ? 0.2 * Math.sin(Math.PI * 2 * 190 * time) * Math.exp(-time * 30)
          : 0;
      sample =
        (high * 0.52 + body) *
        Math.exp(-time * (input.kind === "hat" ? 64 : 25));
    }
    left[frame] = left[frame]! + sample * input.gain * gainL;
    right[frame] = right[frame]! + sample * input.gain * gainR;
  }
}

function wav(left: Float32Array, right: Float32Array): Buffer {
  const bytesPerSample = BITS_PER_SAMPLE / 8;
  const dataLength = left.length * CHANNELS * bytesPerSample;
  const output = Buffer.allocUnsafe(44 + dataLength);
  output.write("RIFF", 0, "ascii");
  output.writeUInt32LE(36 + dataLength, 4);
  output.write("WAVE", 8, "ascii");
  output.write("fmt ", 12, "ascii");
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(CHANNELS, 22);
  output.writeUInt32LE(SAMPLE_RATE, 24);
  output.writeUInt32LE(SAMPLE_RATE * CHANNELS * bytesPerSample, 28);
  output.writeUInt16LE(CHANNELS * bytesPerSample, 32);
  output.writeUInt16LE(BITS_PER_SAMPLE, 34);
  output.write("data", 36, "ascii");
  output.writeUInt32LE(dataLength, 40);
  for (let frame = 0; frame < left.length; frame += 1) {
    const offset = 44 + frame * 4;
    output.writeInt16LE(
      Math.round(Math.max(-1, Math.min(1, left[frame]!)) * 32_767),
      offset,
    );
    output.writeInt16LE(
      Math.round(Math.max(-1, Math.min(1, right[frame]!)) * 32_767),
      offset + 2,
    );
  }
  return output;
}

export function synthesizeLocalMusicBedWav(
  durationUs: number,
  templateId: LocalMusicTemplateId,
): Buffer {
  if (!Number.isSafeInteger(durationUs) || durationUs <= 0) {
    throw new TypeError("Music duration must be a positive integer");
  }
  const template = TEMPLATES[templateId];
  const seconds = durationUs / 1_000_000;
  const frames = Math.max(1, Math.round(seconds * SAMPLE_RATE));
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const beatSeconds = 60 / template.bpm;
  const bars = Math.ceil(seconds / (beatSeconds * 4));
  let eventIndex = 0;

  for (let bar = 0; bar < bars; bar += 1) {
    const chordIndex = template.progression[bar % 4]!;
    const barBeat = bar * 4;
    for (const [noteIndex, midi] of CHORDS[chordIndex]!.entries()) {
      addTone(left, right, {
        start: barBeat * beatSeconds,
        duration: beatSeconds * 2.7,
        midi,
        gain: 0.16,
        pan: -0.45 + noteIndex * 0.3,
        brightness: template.brightness,
        decay: 2.6,
      });
    }
    for (const [noteIndex, onset] of template.groove[bar % 4]!.entries()) {
      addTone(left, right, {
        start: (barBeat + onset) * beatSeconds,
        duration: beatSeconds * (noteIndex % 3 === 2 ? 0.48 : 0.32),
        midi: template.melody[(noteIndex * 2 + bar) % template.melody.length]!,
        gain: templateId === "bright_launch" ? 0.27 : 0.23,
        pan: noteIndex % 2 === 0 ? -0.18 : 0.2,
        brightness: template.brightness,
        decay: 4.5,
      });
    }
    for (const onset of [0, 1.5, 2.5, 3.25]) {
      addTone(left, right, {
        start: (barBeat + onset) * beatSeconds,
        duration: beatSeconds * 0.27,
        midi: BASS[chordIndex]! + (onset === 3.25 ? 7 : 0),
        gain: 0.2,
        pan: 0,
        brightness: 0,
        decay: 5.1,
      });
    }
    for (const onset of [0, 2, ...(bar % 2 === 1 ? [3.25] : [])]) {
      addDrum(left, right, {
        start: (barBeat + onset) * beatSeconds,
        kind: "kick",
        gain: 0.44,
        seed: 0xc0de_0000 + eventIndex++,
      });
    }
    for (const onset of [1, 3, ...(bar % 4 === 3 ? [3.5, 3.75] : [])]) {
      addDrum(left, right, {
        start: (barBeat + onset) * beatSeconds,
        kind: "snare",
        gain: 0.29,
        seed: 0xc0de_0000 + eventIndex++,
      });
    }
    for (let onset = 0; onset < 4; onset += bar % 3 === 2 ? 0.25 : 0.5) {
      addDrum(left, right, {
        start: (barBeat + onset) * beatSeconds,
        kind: "hat",
        gain: onset % 1 === 0 ? 0.17 : 0.13,
        pan: eventIndex % 2 === 0 ? -0.3 : 0.32,
        seed: 0xc0de_0000 + eventIndex++ * 7919,
      });
    }
  }

  let peak = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    peak = Math.max(peak, Math.abs(left[frame]!), Math.abs(right[frame]!));
  }
  const normalize = peak > 0 ? 0.78 / peak : 1;
  const fadeIn = Math.min(frames, Math.round(SAMPLE_RATE * 0.18));
  const fadeOut = Math.min(frames, Math.round(SAMPLE_RATE * 0.5));
  for (let frame = 0; frame < frames; frame += 1) {
    const inGain = Math.min(1, frame / Math.max(1, fadeIn));
    const outGain = Math.min(1, (frames - 1 - frame) / Math.max(1, fadeOut));
    const gain = normalize * inGain * outGain;
    left[frame] = left[frame]! * gain;
    right[frame] = right[frame]! * gain;
  }
  return wav(left, right);
}
