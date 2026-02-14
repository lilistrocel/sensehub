const { test, expect } = require('@playwright/test');

const BASE_URL = 'http://localhost:3002';
const CREDENTIALS = { email: 'admin@sensehub.local', password: 'admin123' };

/**
 * Helper: Log in and return authenticated page
 */
async function login(page) {
  await page.goto(`${BASE_URL}/login`);
  await page.waitForLoadState('networkidle');

  // Fill login form
  await page.fill('input[type="email"], input[name="email"]', CREDENTIALS.email);
  await page.fill('input[type="password"], input[name="password"]', CREDENTIALS.password);
  await page.click('button[type="submit"]');

  // Wait for redirect to dashboard
  await page.waitForURL('**/');
  await page.waitForLoadState('networkidle');
}

/**
 * Helper: Check if horizontal overflow exists on the page
 * Returns an object with overflow details
 */
async function checkHorizontalOverflow(page) {
  return await page.evaluate(() => {
    const results = [];
    const viewportWidth = window.innerWidth;
    const docScrollWidth = document.documentElement.scrollWidth;
    const bodyScrollWidth = document.body.scrollWidth;

    if (docScrollWidth > viewportWidth || bodyScrollWidth > viewportWidth) {
      results.push({
        type: 'PAGE_OVERFLOW',
        viewportWidth,
        docScrollWidth,
        bodyScrollWidth,
        overflowAmount: Math.max(docScrollWidth, bodyScrollWidth) - viewportWidth,
      });
    }

    // Find all elements that overflow their parent or the viewport
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      const rect = el.getBoundingClientRect();
      // Element extends beyond viewport
      if (rect.right > viewportWidth + 2) { // 2px tolerance
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        const classes = el.className && typeof el.className === 'string'
          ? `.${el.className.split(' ').filter(Boolean).slice(0, 3).join('.')}`
          : '';
        const text = el.textContent?.substring(0, 50) || '';
        results.push({
          type: 'ELEMENT_OVERFLOW',
          selector: `${tag}${id}${classes}`,
          rightEdge: Math.round(rect.right),
          viewportWidth,
          overflowAmount: Math.round(rect.right - viewportWidth),
          width: Math.round(rect.width),
          text: text.trim().substring(0, 80),
        });
      }
    }

    return results;
  });
}

/**
 * Helper: Check for elements with hardcoded widths that might cause issues
 */
async function checkFixedWidths(page) {
  return await page.evaluate(() => {
    const problems = [];
    const viewportWidth = window.innerWidth;
    const allElements = document.querySelectorAll('*');

    for (const el of allElements) {
      const style = window.getComputedStyle(el);
      const minWidth = parseFloat(style.minWidth);
      const width = parseFloat(style.width);
      const rect = el.getBoundingClientRect();

      // Check for fixed min-widths that exceed viewport
      if (minWidth > viewportWidth * 0.9 && style.minWidth.includes('px')) {
        const tag = el.tagName.toLowerCase();
        const classes = el.className && typeof el.className === 'string'
          ? el.className.split(' ').filter(Boolean).slice(0, 3).join(' ')
          : '';
        problems.push({
          type: 'FIXED_MIN_WIDTH',
          selector: `${tag}.${classes}`,
          minWidth: Math.round(minWidth),
          viewportWidth,
        });
      }

      // Check for tables wider than viewport
      if (el.tagName === 'TABLE' && rect.width > viewportWidth) {
        problems.push({
          type: 'TABLE_OVERFLOW',
          width: Math.round(rect.width),
          viewportWidth,
          overflowAmount: Math.round(rect.width - viewportWidth),
        });
      }

      // Check for SVGs with hardcoded dimensions
      if (el.tagName === 'svg' && rect.width > viewportWidth * 0.95) {
        problems.push({
          type: 'SVG_OVERFLOW',
          width: Math.round(rect.width),
          viewportWidth,
        });
      }
    }

    return problems;
  });
}

/**
 * Helper: Check touch target sizes (min 44x44 recommended)
 */
async function checkTouchTargets(page) {
  return await page.evaluate(() => {
    const problems = [];
    const clickables = document.querySelectorAll('button, a, input, select, [role="button"], [onclick]');

    for (const el of clickables) {
      const rect = el.getBoundingClientRect();
      // Skip hidden elements
      if (rect.width === 0 || rect.height === 0) continue;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;

      if (rect.width < 44 || rect.height < 44) {
        const tag = el.tagName.toLowerCase();
        const text = el.textContent?.trim().substring(0, 30) || el.getAttribute('aria-label') || '';
        problems.push({
          selector: tag,
          text,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }
    }

    return problems;
  });
}

/**
 * Helper: Check for text truncation or overlap
 */
async function checkTextIssues(page) {
  return await page.evaluate(() => {
    const issues = [];
    const textElements = document.querySelectorAll('h1, h2, h3, h4, p, span, td, th, label, button');

    for (const el of textElements) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) continue;

      // Check if text is cut off (scrollWidth > clientWidth without overflow handling)
      if (el.scrollWidth > el.clientWidth + 2) {
        const style = window.getComputedStyle(el);
        const hasOverflowHandling = style.overflow === 'hidden' || style.textOverflow === 'ellipsis' || style.whiteSpace === 'nowrap';

        // Only flag if there's no proper overflow handling
        if (!hasOverflowHandling && style.overflow !== 'auto' && style.overflow !== 'scroll') {
          const tag = el.tagName.toLowerCase();
          const text = el.textContent?.trim().substring(0, 60) || '';
          issues.push({
            type: 'TEXT_OVERFLOW',
            selector: tag,
            text,
            clientWidth: Math.round(el.clientWidth),
            scrollWidth: Math.round(el.scrollWidth),
          });
        }
      }
    }
    return issues;
  });
}

// ===================== TESTS =====================

test.describe('Mobile Responsiveness Audit', () => {

  test.describe('Login Page', () => {
    test('should not have horizontal overflow', async ({ page }) => {
      await page.goto(`${BASE_URL}/login`);
      await page.waitForLoadState('networkidle');

      const overflows = await checkHorizontalOverflow(page);
      const pageOverflows = overflows.filter(o => o.type === 'PAGE_OVERFLOW');

      if (pageOverflows.length > 0) {
        console.log('LOGIN PAGE OVERFLOW:', JSON.stringify(pageOverflows, null, 2));
      }

      expect(pageOverflows, 'Login page has horizontal scroll overflow').toHaveLength(0);
    });

    test('login form should be fully visible', async ({ page }) => {
      await page.goto(`${BASE_URL}/login`);
      await page.waitForLoadState('networkidle');

      // Check form fits within viewport
      const formOverflows = await checkHorizontalOverflow(page);
      const elementOverflows = formOverflows.filter(o => o.type === 'ELEMENT_OVERFLOW');

      if (elementOverflows.length > 0) {
        console.log('LOGIN ELEMENT OVERFLOWS:', JSON.stringify(elementOverflows.slice(0, 10), null, 2));
      }

      await page.screenshot({ path: `screenshots/login-${test.info().project.name}.png`, fullPage: true });
    });
  });

  test.describe('Dashboard Page', () => {
    test.beforeEach(async ({ page }) => {
      await login(page);
    });

    test('should not have horizontal overflow', async ({ page }) => {
      const overflows = await checkHorizontalOverflow(page);
      const pageOverflows = overflows.filter(o => o.type === 'PAGE_OVERFLOW');

      if (pageOverflows.length > 0) {
        console.log('DASHBOARD PAGE OVERFLOW:', JSON.stringify(pageOverflows, null, 2));
      }

      await page.screenshot({ path: `screenshots/dashboard-${test.info().project.name}.png`, fullPage: true });

      expect(pageOverflows, 'Dashboard has horizontal scroll overflow').toHaveLength(0);
    });

    test('should not have elements overflowing viewport', async ({ page }) => {
      const overflows = await checkHorizontalOverflow(page);
      const significantOverflows = overflows.filter(o => o.type === 'ELEMENT_OVERFLOW' && o.overflowAmount > 10);

      if (significantOverflows.length > 0) {
        console.log('DASHBOARD ELEMENT OVERFLOWS:', JSON.stringify(significantOverflows.slice(0, 15), null, 2));
      }

      // Fail if there are significant overflows (>10px beyond viewport)
      expect(significantOverflows.length, `Dashboard has ${significantOverflows.length} elements overflowing viewport`).toBeLessThanOrEqual(0);
    });

    test('should not have fixed width issues', async ({ page }) => {
      const fixedWidths = await checkFixedWidths(page);

      if (fixedWidths.length > 0) {
        console.log('DASHBOARD FIXED WIDTH ISSUES:', JSON.stringify(fixedWidths, null, 2));
      }
    });

    test('stats cards should stack on mobile', async ({ page }) => {
      await page.screenshot({ path: `screenshots/dashboard-stats-${test.info().project.name}.png`, fullPage: true });

      // Check that the stats grid doesn't overflow
      const overflows = await checkHorizontalOverflow(page);
      const gridOverflows = overflows.filter(o =>
        o.type === 'ELEMENT_OVERFLOW' && o.selector && o.selector.includes('grid')
      );

      if (gridOverflows.length > 0) {
        console.log('DASHBOARD GRID OVERFLOWS:', JSON.stringify(gridOverflows, null, 2));
      }
    });
  });

  test.describe('Equipment Page', () => {
    test.beforeEach(async ({ page }) => {
      await login(page);
      await page.goto(`${BASE_URL}/equipment`);
      await page.waitForLoadState('networkidle');
    });

    test('should not have horizontal overflow', async ({ page }) => {
      const overflows = await checkHorizontalOverflow(page);
      const pageOverflows = overflows.filter(o => o.type === 'PAGE_OVERFLOW');

      await page.screenshot({ path: `screenshots/equipment-${test.info().project.name}.png`, fullPage: true });

      if (pageOverflows.length > 0) {
        console.log('EQUIPMENT PAGE OVERFLOW:', JSON.stringify(pageOverflows, null, 2));
      }

      expect(pageOverflows, 'Equipment page has horizontal scroll overflow').toHaveLength(0);
    });

    test('should not have element overflows', async ({ page }) => {
      const overflows = await checkHorizontalOverflow(page);
      const significantOverflows = overflows.filter(o => o.type === 'ELEMENT_OVERFLOW' && o.overflowAmount > 10);

      if (significantOverflows.length > 0) {
        console.log('EQUIPMENT ELEMENT OVERFLOWS:', JSON.stringify(significantOverflows.slice(0, 15), null, 2));
      }

      expect(significantOverflows.length, `Equipment has ${significantOverflows.length} elements overflowing`).toBeLessThanOrEqual(0);
    });

    test('check table responsiveness', async ({ page }) => {
      const fixedWidths = await checkFixedWidths(page);
      const tableIssues = fixedWidths.filter(f => f.type === 'TABLE_OVERFLOW');

      if (tableIssues.length > 0) {
        console.log('EQUIPMENT TABLE OVERFLOW:', JSON.stringify(tableIssues, null, 2));
      }
    });
  });

  test.describe('Zones Page', () => {
    test.beforeEach(async ({ page }) => {
      await login(page);
      await page.goto(`${BASE_URL}/zones`);
      await page.waitForLoadState('networkidle');
    });

    test('should not have horizontal overflow', async ({ page }) => {
      const overflows = await checkHorizontalOverflow(page);
      const pageOverflows = overflows.filter(o => o.type === 'PAGE_OVERFLOW');

      await page.screenshot({ path: `screenshots/zones-${test.info().project.name}.png`, fullPage: true });

      if (pageOverflows.length > 0) {
        console.log('ZONES PAGE OVERFLOW:', JSON.stringify(pageOverflows, null, 2));
      }

      expect(pageOverflows, 'Zones page has horizontal scroll overflow').toHaveLength(0);
    });

    test('should not have element overflows', async ({ page }) => {
      const overflows = await checkHorizontalOverflow(page);
      const significantOverflows = overflows.filter(o => o.type === 'ELEMENT_OVERFLOW' && o.overflowAmount > 10);

      if (significantOverflows.length > 0) {
        console.log('ZONES ELEMENT OVERFLOWS:', JSON.stringify(significantOverflows.slice(0, 15), null, 2));
      }

      expect(significantOverflows.length, `Zones has ${significantOverflows.length} elements overflowing`).toBeLessThanOrEqual(0);
    });
  });

  test.describe('Automations Page', () => {
    test.beforeEach(async ({ page }) => {
      await login(page);
      await page.goto(`${BASE_URL}/automations`);
      await page.waitForLoadState('networkidle');
    });

    test('should not have horizontal overflow', async ({ page }) => {
      const overflows = await checkHorizontalOverflow(page);
      const pageOverflows = overflows.filter(o => o.type === 'PAGE_OVERFLOW');

      await page.screenshot({ path: `screenshots/automations-${test.info().project.name}.png`, fullPage: true });

      if (pageOverflows.length > 0) {
        console.log('AUTOMATIONS PAGE OVERFLOW:', JSON.stringify(pageOverflows, null, 2));
      }

      expect(pageOverflows, 'Automations page has horizontal scroll overflow').toHaveLength(0);
    });

    test('should not have element overflows', async ({ page }) => {
      const overflows = await checkHorizontalOverflow(page);
      const significantOverflows = overflows.filter(o => o.type === 'ELEMENT_OVERFLOW' && o.overflowAmount > 10);

      if (significantOverflows.length > 0) {
        console.log('AUTOMATIONS ELEMENT OVERFLOWS:', JSON.stringify(significantOverflows.slice(0, 15), null, 2));
      }

      expect(significantOverflows.length, `Automations has ${significantOverflows.length} elements overflowing`).toBeLessThanOrEqual(0);
    });
  });

  test.describe('Alerts Page', () => {
    test.beforeEach(async ({ page }) => {
      await login(page);
      await page.goto(`${BASE_URL}/alerts`);
      await page.waitForLoadState('networkidle');
    });

    test('should not have horizontal overflow', async ({ page }) => {
      const overflows = await checkHorizontalOverflow(page);
      const pageOverflows = overflows.filter(o => o.type === 'PAGE_OVERFLOW');

      await page.screenshot({ path: `screenshots/alerts-${test.info().project.name}.png`, fullPage: true });

      if (pageOverflows.length > 0) {
        console.log('ALERTS PAGE OVERFLOW:', JSON.stringify(pageOverflows, null, 2));
      }

      expect(pageOverflows, 'Alerts page has horizontal scroll overflow').toHaveLength(0);
    });

    test('should not have element overflows', async ({ page }) => {
      const overflows = await checkHorizontalOverflow(page);
      const significantOverflows = overflows.filter(o => o.type === 'ELEMENT_OVERFLOW' && o.overflowAmount > 10);

      if (significantOverflows.length > 0) {
        console.log('ALERTS ELEMENT OVERFLOWS:', JSON.stringify(significantOverflows.slice(0, 15), null, 2));
      }

      expect(significantOverflows.length, `Alerts has ${significantOverflows.length} elements overflowing`).toBeLessThanOrEqual(0);
    });

    test('check alerts table on mobile', async ({ page }) => {
      const fixedWidths = await checkFixedWidths(page);
      const tableIssues = fixedWidths.filter(f => f.type === 'TABLE_OVERFLOW');

      if (tableIssues.length > 0) {
        console.log('ALERTS TABLE OVERFLOW:', JSON.stringify(tableIssues, null, 2));
      }
    });
  });

  test.describe('Settings Page', () => {
    test.beforeEach(async ({ page }) => {
      await login(page);
      await page.goto(`${BASE_URL}/settings`);
      await page.waitForLoadState('networkidle');
    });

    test('should not have horizontal overflow', async ({ page }) => {
      const overflows = await checkHorizontalOverflow(page);
      const pageOverflows = overflows.filter(o => o.type === 'PAGE_OVERFLOW');

      await page.screenshot({ path: `screenshots/settings-${test.info().project.name}.png`, fullPage: true });

      if (pageOverflows.length > 0) {
        console.log('SETTINGS PAGE OVERFLOW:', JSON.stringify(pageOverflows, null, 2));
      }

      expect(pageOverflows, 'Settings page has horizontal scroll overflow').toHaveLength(0);
    });

    test('should not have element overflows', async ({ page }) => {
      const overflows = await checkHorizontalOverflow(page);
      const significantOverflows = overflows.filter(o => o.type === 'ELEMENT_OVERFLOW' && o.overflowAmount > 10);

      if (significantOverflows.length > 0) {
        console.log('SETTINGS ELEMENT OVERFLOWS:', JSON.stringify(significantOverflows.slice(0, 15), null, 2));
      }

      expect(significantOverflows.length, `Settings has ${significantOverflows.length} elements overflowing`).toBeLessThanOrEqual(0);
    });

    test('settings tabs should be scrollable or stackable', async ({ page }) => {
      // Check if settings navigation fits
      const overflows = await checkHorizontalOverflow(page);
      const navOverflows = overflows.filter(o =>
        o.type === 'ELEMENT_OVERFLOW' && o.selector && (o.selector.includes('nav') || o.selector.includes('tab'))
      );

      if (navOverflows.length > 0) {
        console.log('SETTINGS NAV OVERFLOWS:', JSON.stringify(navOverflows, null, 2));
      }
    });
  });

  test.describe('Touch Targets Audit', () => {
    test('dashboard touch targets should be at least 44x44', async ({ page }) => {
      await login(page);

      const smallTargets = await checkTouchTargets(page);

      if (smallTargets.length > 0) {
        console.log(`DASHBOARD: ${smallTargets.length} small touch targets found:`);
        console.log(JSON.stringify(smallTargets.slice(0, 20), null, 2));
      }

      // This is informational - log but allow some small targets (icons, etc)
      const criticallySmall = smallTargets.filter(t => t.width < 30 || t.height < 30);
      if (criticallySmall.length > 0) {
        console.log('CRITICALLY SMALL TARGETS (<30px):', JSON.stringify(criticallySmall, null, 2));
      }
    });
  });

  test.describe('Full Page Scroll Audit', () => {
    const pages = [
      { name: 'dashboard', path: '/' },
      { name: 'equipment', path: '/equipment' },
      { name: 'zones', path: '/zones' },
      { name: 'automations', path: '/automations' },
      { name: 'alerts', path: '/alerts' },
      { name: 'settings', path: '/settings' },
    ];

    for (const pg of pages) {
      test(`${pg.name}: page body should not scroll horizontally`, async ({ page }) => {
        await login(page);
        await page.goto(`${BASE_URL}${pg.path}`);
        await page.waitForLoadState('networkidle');

        // Attempt to scroll right and check if it moved
        const canScrollHorizontally = await page.evaluate(() => {
          const before = window.scrollX;
          window.scrollTo(10000, 0);
          const after = window.scrollX;
          window.scrollTo(0, 0); // reset
          return {
            couldScroll: after > before,
            scrolledTo: after,
            documentWidth: document.documentElement.scrollWidth,
            viewportWidth: window.innerWidth,
            overflow: document.documentElement.scrollWidth - window.innerWidth,
          };
        });

        if (canScrollHorizontally.couldScroll) {
          console.log(`${pg.name.toUpperCase()} CAN SCROLL HORIZONTALLY:`, JSON.stringify(canScrollHorizontally, null, 2));
        }

        await page.screenshot({ path: `screenshots/${pg.name}-scroll-test-${test.info().project.name}.png`, fullPage: true });

        expect(canScrollHorizontally.couldScroll,
          `${pg.name} page can scroll horizontally by ${canScrollHorizontally.overflow}px`
        ).toBe(false);
      });
    }
  });
});
