import { InjectionToken, inject } from '@angular/core';

import type { AiProvider } from './ai-provider';
import { SettingsService } from '../services/settings.service';

/**
 * The active text provider. Resolves the concrete provider from
 * {@link SettingsService} on every call, so entering a key in Settings takes
 * effect on the next generation. Tests override this token with a FakeProvider.
 */
export const AI_PROVIDER = new InjectionToken<AiProvider>('AI_PROVIDER', {
  providedIn: 'root',
  factory: () => {
    const settings = inject(SettingsService);
    return {
      id: 'live',
      generate: (messages, opts) =>
        settings.buildProvider().generate(messages, opts),
      testConnection: (model) => settings.buildProvider().testConnection(model),
    } satisfies AiProvider;
  },
});
