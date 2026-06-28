import { Service, computed, effect, signal } from '@angular/core';

/** Theme preference. `system` tracks the OS `prefers-color-scheme`. */
export type ThemePreference = 'system' | 'light' | 'dark';
/** Resolved theme actually applied to the document. */
export type Theme = 'light' | 'dark';

const KEY = 'lekhak.theme';
const PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark'];

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      return stored;
    }
  } catch {
    // Private mode / disabled storage: fall back to system.
  }
  return 'system';
}

function writePreference(value: ThemePreference): void {
  try {
    localStorage.setItem(KEY, value);
  } catch {
    // Storage unavailable: the choice just won't persist across reloads.
  }
}

function systemQuery(): MediaQueryList | null {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)');
  } catch {
    return null;
  }
}

/**
 * Owns the light/dark theme. The preference (`system` | `light` | `dark`) is
 * persisted to localStorage; the resolved {@link theme} reflects the OS when
 * the preference is `system`. An effect writes `data-theme` onto <html> so the
 * token sets in styles.css switch. The pre-paint script in index.html sets the
 * same attribute first to avoid a flash before Angular boots.
 */
@Service()
export class ThemeService {
  /** What the user chose. `system` follows the OS setting live. */
  readonly preference = signal<ThemePreference>(readPreference());

  private readonly query = systemQuery();
  /** Live OS preference; updates when the user flips their OS theme. */
  private readonly systemDark = signal(this.query?.matches ?? false);

  /** The theme actually applied right now. */
  readonly theme = computed<Theme>(() => {
    const pref = this.preference();
    if (pref === 'system') {
      return this.systemDark() ? 'dark' : 'light';
    }
    return pref;
  });

  constructor() {
    this.query?.addEventListener('change', this.onSystemChange);

    effect(() => {
      const theme = this.theme();
      try {
        document.documentElement.dataset['theme'] = theme;
      } catch {
        // No document (SSR prerender): the inline script handles the client.
      }
    });
  }

  /** Pick a specific preference. Pass `system` to track the OS again. */
  setPreference(value: ThemePreference): void {
    this.preference.set(value);
    writePreference(value);
  }

  /** Cycle system -> light -> dark -> system, for a single toggle control. */
  cycle(): void {
    const next = PREFERENCES[(PREFERENCES.indexOf(this.preference()) + 1) % PREFERENCES.length];
    this.setPreference(next);
  }

  private readonly onSystemChange = (e: MediaQueryListEvent): void => {
    this.systemDark.set(e.matches);
  };
}
