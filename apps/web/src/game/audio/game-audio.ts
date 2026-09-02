export interface GameAudioSettings {
  musicVolume: number;
  sfxVolume: number;
  muted: boolean;
}

export type GameAudioCue =
  | 'countdown'
  | 'go'
  | 'pickup'
  | 'deposit'
  | 'inventory-full'
  | 'sprint-empty'
  | 'shove'
  | 'shoved'
  | 'error'
  | 'time-up';

export const DEFAULT_AUDIO_SETTINGS: GameAudioSettings = Object.freeze({
  musicVolume: 0.28,
  sfxVolume: 0.72,
  muted: false,
});

const SETTINGS_KEY = '69-seconds.presentation-settings.v1';

function clampVolume(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback;
}

export function loadAudioSettings(): GameAudioSettings {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<GameAudioSettings>;
    return {
      musicVolume: clampVolume(parsed.musicVolume, DEFAULT_AUDIO_SETTINGS.musicVolume),
      sfxVolume: clampVolume(parsed.sfxVolume, DEFAULT_AUDIO_SETTINGS.sfxVolume),
      muted: typeof parsed.muted === 'boolean' ? parsed.muted : DEFAULT_AUDIO_SETTINGS.muted,
    };
  } catch {
    return DEFAULT_AUDIO_SETTINGS;
  }
}

export function saveAudioSettings(settings: GameAudioSettings): void {
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

/**
 * Tiny original Web Audio placeholders. They make every event hook testable now
 * without shipping unlicensed samples; final stems can replace this class later.
 */
class ProceduralGameAudio {
  private context?: AudioContext;
  private master?: GainNode;
  private music?: GainNode;
  private sfx?: GainNode;
  private musicStarted = false;
  private settings: GameAudioSettings = DEFAULT_AUDIO_SETTINGS;

  setSettings(settings: GameAudioSettings): void {
    this.settings = settings;
    if (!this.context || !this.master || !this.music || !this.sfx) return;
    const now = this.context.currentTime;
    this.master.gain.setTargetAtTime(settings.muted ? 0 : 1, now, 0.015);
    this.music.gain.setTargetAtTime(settings.musicVolume ** 2 * 0.12, now, 0.03);
    this.sfx.gain.setTargetAtTime(settings.sfxVolume ** 2 * 0.25, now, 0.015);
  }

  async unlock(): Promise<void> {
    if (!this.context) {
      if (typeof window.AudioContext !== 'function') return;
      this.createGraph();
    }
    if (this.context?.state === 'suspended') await this.context.resume();
    this.startMusic();
  }

  play(cue: GameAudioCue): void {
    if (!this.context || !this.sfx || this.settings.muted) return;
    const patterns: Record<GameAudioCue, readonly [number, number, number][]> = {
      countdown: [[330, 0, 0.07]],
      go: [[440, 0, 0.08], [660, 0.08, 0.13]],
      pickup: [[520, 0, 0.055], [780, 0.055, 0.1]],
      deposit: [[260, 0, 0.07], [390, 0.06, 0.1], [620, 0.13, 0.14]],
      'inventory-full': [[180, 0, 0.08], [150, 0.09, 0.12]],
      'sprint-empty': [[240, 0, 0.07], [190, 0.08, 0.1]],
      shove: [[120, 0, 0.08], [210, 0.035, 0.09]],
      shoved: [[95, 0, 0.13]],
      error: [[150, 0, 0.08], [120, 0.09, 0.11]],
      'time-up': [[294, 0, 0.15], [220, 0.16, 0.18], [147, 0.35, 0.35]],
    };
    const start = this.context.currentTime;
    for (const [frequency, offset, duration] of patterns[cue]) {
      const oscillator = this.context.createOscillator();
      const envelope = this.context.createGain();
      oscillator.type = cue === 'shove' || cue === 'shoved' ? 'sawtooth' : 'triangle';
      oscillator.frequency.setValueAtTime(frequency, start + offset);
      envelope.gain.setValueAtTime(0.0001, start + offset);
      envelope.gain.exponentialRampToValueAtTime(0.7, start + offset + 0.008);
      envelope.gain.exponentialRampToValueAtTime(0.0001, start + offset + duration);
      oscillator.connect(envelope).connect(this.sfx);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + duration + 0.01);
    }
  }

  private createGraph(): void {
    const AudioContextConstructor = window.AudioContext;
    this.context = new AudioContextConstructor();
    this.master = this.context.createGain();
    this.music = this.context.createGain();
    this.sfx = this.context.createGain();
    this.music.connect(this.master);
    this.sfx.connect(this.master);
    this.master.connect(this.context.destination);
    this.setSettings(this.settings);
  }

  private startMusic(): void {
    if (this.musicStarted || !this.context || !this.music) return;
    this.musicStarted = true;
    const filter = this.context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 260;
    filter.Q.value = 0.7;
    filter.connect(this.music);
    for (const [frequency, detune] of [[55, -4], [82.5, 3]] as const) {
      const oscillator = this.context.createOscillator();
      oscillator.type = 'triangle';
      oscillator.frequency.value = frequency;
      oscillator.detune.value = detune;
      oscillator.connect(filter);
      oscillator.start();
    }
  }
}

export const gameAudio = new ProceduralGameAudio();
