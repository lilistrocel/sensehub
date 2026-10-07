import { describe, it, expect } from 'vitest';
import { viewsFrom } from './CaptureViews.jsx';

const frame = (id, sequence, name) => ({ id, sequence, preset_name: name, preset_id: id + 10, image_url: `/api/agronomist/captures/${id}/image` });

describe('viewsFrom (canopy views, operator request 2026-10-07)', () => {
  it('keeps every requested view in order and never fills a missing one with another image', () => {
    const views = [
      { index: 1, name: 'Agronomist 1', preset_id: 6, status: 'ok', capture_id: 11 },
      { index: 2, name: 'Agronomist 2', preset_id: null, status: 'missing' },
      { index: 3, name: 'Agronomist 3', preset_id: 5, status: 'ok', capture_id: 13 },
    ];
    const list = viewsFrom({ views, frames: [frame(13, 3, 'Agronomist 3'), frame(11, 1, 'Agronomist 1')] });
    expect(list.map(v => [v.index, v.name, v.status, v.frame?.id ?? null])).toEqual([
      [1, 'Agronomist 1', 'ok', 11], [2, 'Agronomist 2', 'missing', null], [3, 'Agronomist 3', 'ok', 13],
    ]);
  });

  it('a view whose image row is gone shows as missing_file, not as captured', () => {
    const list = viewsFrom({ views: [{ index: 1, name: 'A', status: 'ok', capture_id: 99 }], frames: [] });
    expect(list[0].status).toBe('missing_file');
  });

  it('without session views, one view per frame in sequence order', () => {
    const list = viewsFrom({ views: null, frames: [frame(2, 2, 'B'), frame(1, 1, 'A')] });
    expect(list.map(v => v.name)).toEqual(['A', 'B']);
  });
});
