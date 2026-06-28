import { Component, computed, inject } from '@angular/core';

import { ThemeService, type ThemePreference } from '../services/theme.service';

const LABELS: Record<ThemePreference, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

const NEXT: Record<ThemePreference, ThemePreference> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

/**
 * Single button that cycles the theme preference system -> light -> dark.
 * The icon reflects the current preference (monitor / sun / moon) and the
 * title spells out the next step so the cycle is discoverable.
 */
@Component({
  selector: 'app-theme-toggle',
  template: `
    <button
      type="button"
      class="theme-toggle"
      [attr.aria-label]="label()"
      [title]="label()"
      (click)="theme.cycle()"
    >
      @switch (theme.preference()) {
        @case ('light') {
          <svg viewBox="0 0 24 24" aria-hidden="true" class="ico">
            <circle cx="12" cy="12" r="4.2" />
            <g stroke-linecap="round">
              <line x1="12" y1="2.5" x2="12" y2="5" />
              <line x1="12" y1="19" x2="12" y2="21.5" />
              <line x1="2.5" y1="12" x2="5" y2="12" />
              <line x1="19" y1="12" x2="21.5" y2="12" />
              <line x1="5.1" y1="5.1" x2="6.9" y2="6.9" />
              <line x1="17.1" y1="17.1" x2="18.9" y2="18.9" />
              <line x1="5.1" y1="18.9" x2="6.9" y2="17.1" />
              <line x1="17.1" y1="6.9" x2="18.9" y2="5.1" />
            </g>
          </svg>
        }
        @case ('dark') {
          <svg viewBox="0 0 24 24" aria-hidden="true" class="ico">
            <path d="M20 14.5A8 8 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5z" />
          </svg>
        }
        @default {
          <svg viewBox="0 0 24 24" aria-hidden="true" class="ico">
            <rect x="3" y="4.5" width="18" height="12" rx="1.6" />
            <line x1="9" y1="20" x2="15" y2="20" stroke-linecap="round" />
            <line x1="12" y1="16.5" x2="12" y2="20" />
          </svg>
        }
      }
    </button>
  `,
  styles: [
    `
      .theme-toggle {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 2.75rem;
        min-height: 2.75rem;
        padding: 0.3rem;
        border: 1px solid transparent;
        border-radius: 0.5rem;
        background: transparent;
        color: var(--muted);
        cursor: pointer;
      }
      .theme-toggle:hover {
        color: var(--text);
        background: var(--surface-2);
      }
      .theme-toggle:focus-visible {
        outline: 2px solid var(--focus);
        outline-offset: 1px;
      }
      .ico {
        width: 1.05rem;
        height: 1.05rem;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.7;
      }
    `,
  ],
})
export class ThemeToggleComponent {
  protected readonly theme = inject(ThemeService);

  protected readonly label = computed(() => {
    const pref = this.theme.preference();
    return `Theme: ${LABELS[pref]} — switch to ${LABELS[NEXT[pref]]}`;
  });
}
