import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AiProvider } from '../ai/ai-provider';
import { SettingsService } from './settings.service';

describe('SettingsService', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('defaults to an empty key and the fallback model', () => {
    const svc = new SettingsService();
    expect(svc.apiKey()).toBe('');
    expect(svc.hasKey()).toBe(false);
    expect(svc.provider()).toBe('openai');
    expect(svc.model()).toBe('gpt-4o-mini');
  });

  it('persists the key and model to localStorage', () => {
    const svc = new SettingsService();
    svc.setApiKey('sk-123');
    svc.setModel('gpt-4o');

    expect(localStorage.getItem('lekhak.apiKey')).toBe('sk-123');
    expect(localStorage.getItem('lekhak.model')).toBe('gpt-4o');
    expect(svc.hasKey()).toBe(true);
  });

  it('reads previously saved settings on construction', () => {
    localStorage.setItem('lekhak.apiKey', 'sk-saved');
    localStorage.setItem('lekhak.model', 'custom-model');

    const svc = new SettingsService();
    expect(svc.apiKey()).toBe('sk-saved');
    expect(svc.model()).toBe('custom-model');
  });

  it('treats a whitespace-only key as missing', () => {
    const svc = new SettingsService();
    svc.setApiKey('   ');
    expect(svc.hasKey()).toBe(false);
  });

  it('delegates testConnection to the built provider with the chosen model', async () => {
    const svc = new SettingsService();
    svc.setApiKey('sk-1');
    svc.setModel('m-1');

    const fake: AiProvider = {
      id: 'fake',
      generate: async function* () {},
      testConnection: vi.fn().mockResolvedValue(true),
    };
    vi.spyOn(svc, 'buildProvider').mockReturnValue(fake);

    await expect(svc.testConnection()).resolves.toBe(true);
    expect(fake.testConnection).toHaveBeenCalledWith('m-1');
  });
});
