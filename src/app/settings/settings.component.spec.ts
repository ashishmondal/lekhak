import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsService } from '../services/settings.service';
import { SettingsComponent } from './settings.component';

function render() {
  TestBed.configureTestingModule({
    imports: [SettingsComponent],
    providers: [provideRouter([]), SettingsService],
  });
  const fixture = TestBed.createComponent(SettingsComponent);
  fixture.detectChanges();
  return fixture;
}

describe('SettingsComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    localStorage.clear();
  });

  it('renders the key and model fields', () => {
    const el: HTMLElement = render().nativeElement;
    expect(el.querySelector('input[type="password"]')).toBeTruthy();
    expect(el.querySelector('button.test')?.textContent).toContain(
      'Test connection',
    );
  });

  it('persists the key as it is typed', () => {
    const fixture = render();
    const comp = fixture.componentInstance as any;
    comp.onKeyInput('sk-typed');
    expect(TestBed.inject(SettingsService).apiKey()).toBe('sk-typed');
  });

  it('blocks the connection test when no key is set', async () => {
    const fixture = render();
    const comp = fixture.componentInstance as any;
    await comp.testConnection();
    expect(comp.testState()).toBe('failed');
    expect(comp.testMessage()).toContain('Enter an API key');
  });

  it('reports success when the provider connects', async () => {
    const fixture = render();
    const comp = fixture.componentInstance as any;
    const settings = TestBed.inject(SettingsService);
    settings.setApiKey('sk-ok');
    vi.spyOn(settings, 'testConnection').mockResolvedValue(true);

    await comp.testConnection();

    expect(comp.testState()).toBe('ok');
    expect(comp.testMessage()).toContain('Connected');
  });

  it('reports failure when the provider rejects the key', async () => {
    const fixture = render();
    const comp = fixture.componentInstance as any;
    const settings = TestBed.inject(SettingsService);
    settings.setApiKey('sk-bad');
    vi.spyOn(settings, 'testConnection').mockResolvedValue(false);

    await comp.testConnection();

    expect(comp.testState()).toBe('failed');
    expect(comp.testMessage()).toContain('Could not reach');
  });
});
