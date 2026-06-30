import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AiProvider } from '../ai/ai-provider';
import { GeminiProvider } from '../ai/gemini-provider';
import { OpenAiProvider } from '../ai/openai-provider';
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

  it('persists the key and model to the active provider slot', () => {
    const svc = new SettingsService();
    svc.setApiKey('sk-123');
    svc.setModel('gpt-4o');

    expect(localStorage.getItem('lekhak.apiKey.openai')).toBe('sk-123');
    expect(localStorage.getItem('lekhak.model.openai')).toBe('gpt-4o');
    expect(svc.hasKey()).toBe(true);
  });

  it('migrates legacy single-provider settings into the OpenAI slot', () => {
    localStorage.setItem('lekhak.apiKey', 'sk-saved');
    localStorage.setItem('lekhak.model', 'custom-model');

    const svc = new SettingsService();
    expect(svc.apiKey()).toBe('sk-saved');
    expect(svc.model()).toBe('custom-model');
    expect(localStorage.getItem('lekhak.apiKey.openai')).toBe('sk-saved');
  });

  it('treats a whitespace-only key as missing', () => {
    const svc = new SettingsService();
    svc.setApiKey('   ');
    expect(svc.hasKey()).toBe(false);
  });

  it('keeps a separate key and model per provider when switching', () => {
    const svc = new SettingsService();
    svc.setApiKey('sk-openai');
    svc.setModel('gpt-4o');

    svc.setProvider('gemini');
    // Fresh Gemini slot: empty key, Gemini default model.
    expect(svc.apiKey()).toBe('');
    expect(svc.model()).toBe('gemini-2.5-flash');

    svc.setApiKey('AIza-gemini');
    svc.setModel('gemini-2.5-pro');

    svc.setProvider('openai');
    // OpenAI credentials survived the round trip.
    expect(svc.apiKey()).toBe('sk-openai');
    expect(svc.model()).toBe('gpt-4o');

    expect(localStorage.getItem('lekhak.apiKey.gemini')).toBe('AIza-gemini');
    expect(localStorage.getItem('lekhak.model.gemini')).toBe('gemini-2.5-pro');
  });

  it('falls back to the default provider for an unknown stored value', () => {
    localStorage.setItem('lekhak.provider', 'anthropic');
    const svc = new SettingsService();
    expect(svc.provider()).toBe('openai');
  });

  it('defaults the writing style to banter and persists changes', () => {
    const svc = new SettingsService();
    expect(svc.style()).toBe('banter');

    svc.setStyle('heartfelt');
    expect(svc.style()).toBe('heartfelt');
    expect(localStorage.getItem('lekhak.style')).toBe('heartfelt');
  });

  it('ignores an unknown stored style', () => {
    localStorage.setItem('lekhak.style', 'novelist');
    const svc = new SettingsService();
    expect(svc.style()).toBe('banter');
  });

  it('accepts a stored custom style id when that persona exists', () => {
    localStorage.setItem('lekhak.style', 'custom-1');
    localStorage.setItem(
      'lekhak.customStyles',
      JSON.stringify([
        {
          id: 'custom-1',
          label: 'Scene Partner',
          description: 'Focused on dialogue chemistry.',
          persona: 'You are a fiction writer with dialogue-first scenes.',
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    );
    const svc = new SettingsService();
    expect(svc.style()).toBe('custom-1');
  });

  it('adds, updates, and deletes a custom persona', () => {
    const svc = new SettingsService();
    const id = svc.addCustomStyle({
      label: 'Scene Partner',
      description: 'Focused on dialogue chemistry.',
      persona: 'You are a fiction writer with dialogue-first scenes.',
    });

    expect(id).toBeTruthy();
    expect(svc.customStyles()).toHaveLength(1);
    expect(localStorage.getItem('lekhak.customStyles')).toContain('Scene Partner');

    const updated = svc.updateCustomStyle(id!, {
      label: 'Scene Partner v2',
      description: 'Updated hint',
      persona: 'Updated persona body',
    });
    expect(updated).toBe(true);
    expect(svc.customStyles()[0].label).toBe('Scene Partner v2');

    svc.setStyle(id!);
    expect(svc.style()).toBe(id);
    svc.deleteCustomStyle(id!);

    expect(svc.customStyles()).toHaveLength(0);
    expect(svc.style()).toBe('banter');
  });

  it('defaults every consistency surface OFF', () => {
    const svc = new SettingsService();
    expect(svc.driftCheck()).toBe(false);
    expect(svc.extraction()).toBe(false);
    expect(svc.canonCheck()).toBe(false);
  });

  it('persists each consistency toggle independently', () => {
    const svc = new SettingsService();
    svc.setDriftCheck(true);
    svc.setExtraction(true);
    svc.setCanonCheck(true);

    expect(localStorage.getItem('lekhak.consistency.drift')).toBe('true');
    expect(localStorage.getItem('lekhak.consistency.extraction')).toBe('true');
    expect(localStorage.getItem('lekhak.consistency.canon')).toBe('true');

    // A fresh instance reads them back.
    const reloaded = new SettingsService();
    expect(reloaded.driftCheck()).toBe(true);
    expect(reloaded.extraction()).toBe(true);
    expect(reloaded.canonCheck()).toBe(true);

    svc.setDriftCheck(false);
    expect(localStorage.getItem('lekhak.consistency.drift')).toBe('false');
  });

  it('builds the provider matching the active selection', () => {
    const svc = new SettingsService();
    svc.setApiKey('sk-1');
    expect(svc.buildProvider()).toBeInstanceOf(OpenAiProvider);

    svc.setProvider('gemini');
    expect(svc.buildProvider()).toBeInstanceOf(GeminiProvider);
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
