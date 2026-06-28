import { TestBed } from '@angular/core/testing';

import { ThemeService } from './theme.service';

const KEY = 'lekhak.theme';

describe('ThemeService', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  function create(): ThemeService {
    return TestBed.runInInjectionContext(() => new ThemeService());
  }

  it('defaults to the system preference when nothing is stored', () => {
    const service = create();
    expect(service.preference()).toBe('system');
  });

  it('restores a persisted preference', () => {
    localStorage.setItem(KEY, 'dark');
    const service = create();
    expect(service.preference()).toBe('dark');
    expect(service.theme()).toBe('dark');
  });

  it('persists and resolves an explicit light preference', () => {
    const service = create();
    service.setPreference('light');
    expect(service.theme()).toBe('light');
    expect(localStorage.getItem(KEY)).toBe('light');
  });

  it('cycles system -> light -> dark -> system', () => {
    const service = create();
    expect(service.preference()).toBe('system');
    service.cycle();
    expect(service.preference()).toBe('light');
    service.cycle();
    expect(service.preference()).toBe('dark');
    service.cycle();
    expect(service.preference()).toBe('system');
  });

  it('writes data-theme onto the document element', () => {
    const service = create();
    service.setPreference('dark');
    TestBed.tick();
    expect(document.documentElement.dataset['theme']).toBe('dark');
    service.setPreference('light');
    TestBed.tick();
    expect(document.documentElement.dataset['theme']).toBe('light');
  });
});
