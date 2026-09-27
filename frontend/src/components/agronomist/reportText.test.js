import { describe, it, expect } from 'vitest';
import { reportTextProps } from './reportText';
import { weekdayName, dateWeekday } from './weekday';
import { splitReportSections } from './splitReportSections';
import { classifyPlanError } from '../planner/FailureBanner';

describe('reportTextProps (language of AI report text)', () => {
  it('adds nothing in English', () => {
    expect(reportTextProps({ translation_status: 'original' }, 'en')).toEqual({});
  });
  it('marks the English original inside the Arabic UI as ltr English', () => {
    expect(reportTextProps({ translation_status: 'original', translation_language: 'en' }, 'ar')).toEqual({ lang: 'en', dir: 'ltr' });
    expect(reportTextProps({ translation_status: 'pending' }, 'ar')).toEqual({ lang: 'en', dir: 'ltr' });
    expect(reportTextProps({ translation_status: 'failed' }, 'tr')).toEqual({ lang: 'en', dir: 'ltr' });
  });
  it('adds nothing when the translation matches the UI language', () => {
    expect(reportTextProps({ translation_status: 'ready', translation_language: 'ar' }, 'ar')).toEqual({});
    expect(reportTextProps({ translation_status: 'ready', translation_language: 'tr' }, 'tr')).toEqual({});
  });
  it('pseudo / unknown UI language behaves like English', () => {
    expect(reportTextProps({ translation_status: 'original' }, 'pseudo')).toEqual({});
  });
});

describe('weekday helpers', () => {
  it('0 is Sunday in every language, Latin digits untouched', () => {
    expect(weekdayName(0, 'en', 'long')).toBe('Sunday');
    expect(weekdayName(1, 'tr', 'long')).toBe('Pazartesi');
    expect(weekdayName(7, 'en')).toBe('?');
  });
  it('weekday of a calendar date does not shift with the timezone', () => {
    expect(dateWeekday('2026-09-27', 'en')).toBe('Sun');
    expect(dateWeekday('', 'en')).toBe('');
  });
});

describe('splitReportSections keeps parsing English headings of old reports', () => {
  it('classifies the fixed English headings', () => {
    const md = '# Daily report\n\n## State of the Crop\nok\n\n## Irrigation & Fertigation\nx\n\n## Recommendations\n- a';
    const { sections } = splitReportSections(md);
    expect(sections.map(s => s.key)).toEqual(['crop', 'irrigation', 'recommendations']);
  });
});

describe('classifyPlanError', () => {
  it('returns a translation key for the classified reasons and the raw text otherwise', () => {
    expect(classifyPlanError('Your credit balance is too low').key).toBe('credits');
    expect(classifyPlanError('401 Unauthorized').key).toBe('auth');
    expect(classifyPlanError('').key).toBe('none');
    const other = classifyPlanError('socket hang up');
    expect(other.key).toBe(null);
    expect(other.reason).toBe('socket hang up');
  });
});
