/** The autosave lifecycle, surfaced to the editor as a small status. */
export type SaveState = 'saved' | 'saving' | 'failed';

/** Human label for the status chip. */
export function saveStateLabel(state: SaveState): string {
  switch (state) {
    case 'saving':
      return 'Saving…';
    case 'failed':
      return 'Save failed';
    case 'saved':
    default:
      return 'Saved';
  }
}
