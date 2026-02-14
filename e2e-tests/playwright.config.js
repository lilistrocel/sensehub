const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './',
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: 'http://localhost:3002',
    screenshot: 'on',
    trace: 'on-first-retry',
  },
  projects: [
    // Small phone (320px) - Chromium-based
    {
      name: 'Small-Phone-320',
      use: {
        ...devices['Pixel 5'],
        viewport: { width: 320, height: 568 },
      },
    },
    // Medium phone (375px) - Chromium-based
    {
      name: 'Medium-Phone-375',
      use: {
        ...devices['Pixel 5'],
        viewport: { width: 375, height: 667 },
      },
    },
    // Large phone (414px) - Chromium-based
    {
      name: 'Large-Phone-414',
      use: {
        ...devices['Pixel 5'],
        viewport: { width: 414, height: 896 },
      },
    },
    // Small tablet (768px) - Chromium
    {
      name: 'Tablet-768',
      use: {
        ...devices['Pixel 5'],
        viewport: { width: 768, height: 1024 },
        isMobile: false,
      },
    },
  ],
});
