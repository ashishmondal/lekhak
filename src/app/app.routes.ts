import { Routes } from '@angular/router';

import { EditorComponent } from './editor/editor.component';
import { SettingsComponent } from './settings/settings.component';
import { WorldPanelComponent } from './world/world-panel.component';

export const routes: Routes = [
  { path: '', component: EditorComponent },
  { path: 'world', component: WorldPanelComponent },
  { path: 'settings', component: SettingsComponent },
];
