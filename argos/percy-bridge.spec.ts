import { expect, test } from '@playwright/test';
import { argosScreenshot } from '@argos-ci/playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from './read-percy-config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE_URL = `http://localhost:${process.env.ARGOS_PORT || 6103}`;
const SCREENSHOT_ROOT = path.join(ROOT, 'argos', 'screenshots');

// `@percy/core` defaults, used because `.percy.yml` does not override them.
const WIDTH = 1280;
const MIN_HEIGHT = 1024;

// The acceptance suite is split into partitions by `ember-exam`, the same way
// `ember exam --parallel` splits it in the existing Test workflow.
const SPLIT = Number(process.env.ARGOS_SPLIT || 4);

// A capture only happens where a `percySnapshot()` sits, so the run loads the
// acceptance modules that call one and leaves the rest alone. `ember-exam`
// takes a regular expression in its `modulePath` query param.
function acceptanceModulesWithSnapshots(dir: string, found: string[] = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      acceptanceModulesWithSnapshots(full, found);
    } else if (entry.name.endsWith('-test.js') && fs.readFileSync(full, 'utf8').includes('percySnapshot')) {
      found.push(path.relative(ROOT, full).replace(/\.js$/, ''));
    }
  }

  return found;
}

const SNAPSHOT_MODULES = acceptanceModulesWithSnapshots(path.join(ROOT, 'tests', 'acceptance')).sort();

// A few snapshot names are used by more than one test. A screenshot is a file,
// so two partitions writing the same name would race and one capture would
// silently replace the other. Those names get a stable suffix, and so does any
// name that comes back a second time inside a partition (a shared helper called
// by two tests repeats its names at run time without repeating them in source).
const REPEATED_NAMES = new Set(
  Object.entries(
    SNAPSHOT_MODULES.flatMap((module) => [
      ...fs.readFileSync(path.join(ROOT, `${module}.js`), 'utf8').matchAll(/percySnapshot\(\s*'([^']*)'/g),
    ]).reduce<Record<string, number>>((counts, match) => {
      counts[match[1]] = (counts[match[1]] || 0) + 1;

      return counts;
    }, {}),
  )
    .filter(([, count]) => count > 1)
    .map(([name]) => name),
);

const MODULE_PATH =
  process.env.ARGOS_MODULE_PATH ||
  `/(${SNAPSHOT_MODULES.map((module) => module.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$/`;

// `.percy.yml` freezes the timestamps that would otherwise differ on every run.
const PERCY_CONFIG_CSS = yaml.percyCSS(path.join(ROOT, '.percy.yml'));

// `.percy.yml` also keeps a list of hosts Percy never requests. Honouring it
// here keeps the two tools looking at the same page.
const DISALLOWED_HOSTNAMES: string[] = yaml.disallowedHostnames(path.join(ROOT, '.percy.yml'));

// `@percy/ember` scopes every snapshot to `#ember-testing` and drops the id so
// that the QUnit container styles (a 640x384 box holding a 200% surface scaled
// down by half) do not reach the screenshot. Same idea here, minus the DOM
// surgery: the testing chrome is neutralised with a stylesheet while the
// screenshot is taken, then the stylesheet goes away.
const TESTING_CONTAINER_CSS = `
  #qunit { display: none !important; }
  #qunit-fixture {
    position: static !important;
    display: block !important;
    visibility: visible !important;
    opacity: 1 !important;
    top: auto !important;
    left: auto !important;
    width: auto !important;
    height: auto !important;
  }
  #ember-testing-container {
    position: static !important;
    width: 100% !important;
    height: auto !important;
    min-height: ${MIN_HEIGHT}px !important;
    overflow: visible !important;
    border: 0 !important;
    background: white !important;
  }
  #ember-testing {
    width: 100% !important;
    height: auto !important;
    min-height: ${MIN_HEIGHT}px !important;
    transform: none !important;
  }
`;

const PERCY_DOM_STUB = `window.PercyDOM = { serialize: () => '' };`;

// Upper bound on a single capture. The Argos SDK waits for the page to settle
// with its own unbounded wait, so the deadline has to come from here.
const CAPTURE_TIMEOUT = Number(process.env.ARGOS_CAPTURE_TIMEOUT || 60000);

// How long the QUnit run may go without finishing a single test before the
// partition is declared stalled.
const STALL_TIMEOUT = Number(process.env.ARGOS_STALL_TIMEOUT || 180000);

function withDeadline<T>(promise: Promise<T>, name: string) {
  let timer: NodeJS.Timeout;

  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`capture did not finish in ${CAPTURE_TIMEOUT}ms`)), CAPTURE_TIMEOUT * 2);
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

function safeName(name: string) {
  // A snapshot name becomes a file name: a slash would create a directory and
  // anything past 255 bytes dies with ENAMETOOLONG.
  const flat = name.replace(/[\\/]+/g, ' - ').replace(/\s+/g, ' ').trim();

  return Buffer.byteLength(flat) > 200 ? Buffer.from(flat).subarray(0, 200).toString() : flat;
}

for (let partition = 1; partition <= SPLIT; partition++) {
  test(`acceptance partition ${partition}`, async ({ page }, testInfo) => {
    testInfo.setTimeout(30 * 60 * 1000);

    const seen = new Map<string, number>();
    const captured: string[] = [];
    const failures: string[] = [];

    // Without this, a page that never settles parks a capture forever and the
    // partition dies on the test timeout with nothing to show for it.
    page.setDefaultTimeout(CAPTURE_TIMEOUT);

    await page.setViewportSize({ width: WIDTH, height: MIN_HEIGHT });

    for (const hostname of DISALLOWED_HOSTNAMES) {
      await page.route(`**://${hostname}/**`, (route) => route.abort());
    }

    await page.route('**/percy/healthcheck', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json', 'x-percy-core-version': '1.31.8' },
        body: JSON.stringify({ success: true, type: 'web', config: {}, build: {}, widths: {} }),
      }),
    );

    await page.route('**/percy/dom.js', (route) =>
      route.fulfill({ status: 200, headers: { 'content-type': 'text/javascript' }, body: PERCY_DOM_STUB }),
    );

    // Every `percySnapshot()` in the acceptance suite lands here: the test is
    // parked on this request, so the page is exactly in the state Percy sees.
    await page.route('**/percy/snapshot', async (route) => {
      const payload = (route.request().postDataJSON() || {}) as {
        name?: string;
        scope?: string;
        percyCss?: string;
      };

      const raw = payload.name || 'Unnamed snapshot';
      const count = (seen.get(raw) || 0) + 1;
      seen.set(raw, count);
      const name = safeName(REPEATED_NAMES.has(raw) || count > 1 ? `${raw} (${partition}.${count})` : raw);

      let style: { evaluate?: unknown } | null = null;
      const startedAt = Date.now();

      try {
        style = await page.addStyleTag({
          content: [TESTING_CONTAINER_CSS, PERCY_CONFIG_CSS, payload.percyCss || ''].join('\n'),
        });

        await withDeadline(
          argosScreenshot(page, name, {
            root: SCREENSHOT_ROOT,
            element: payload.scope || '#ember-testing',
            animations: 'disabled',
            timeout: CAPTURE_TIMEOUT,
          }),
          name,
        );

        captured.push(name);
        console.log(`p${partition} ${captured.length} ${Date.now() - startedAt}ms ${name}`);
      } catch (error) {
        failures.push(`${name}: ${(error as Error).message}`);
      } finally {
        if (style) {
          await (style as any).evaluate((node: Element) => node.remove()).catch(() => {});
        }
      }

      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ success: true }),
      });
    });

    await page.addInitScript(() => {
      const w = window as any;

      w.__argosDone = false;
      w.__argosCurrent = 'boot';
      w.__argosProgressAt = Date.now();

      const timer = setInterval(() => {
        const qunit = w.QUnit;

        if (qunit && typeof qunit.done === 'function') {
          clearInterval(timer);

          qunit.testStart((details: { module: string; name: string }) => {
            w.__argosCurrent = `${details.module} | ${details.name}`;
            w.__argosProgressAt = Date.now();
          });

          qunit.testDone(() => {
            w.__argosProgressAt = Date.now();
          });

          qunit.done((result: unknown) => {
            w.__argosResult = result;
            w.__argosDone = true;
          });
        }
      }, 25);
    });

    page.on('pageerror', (error) => console.log(`p${partition} pageerror ${error.message}`));

    const url = `${BASE_URL}/tests/index.html?hidepassed&devmode=false&modulePath=${encodeURIComponent(
      MODULE_PATH,
    )}&split=${SPLIT}&partition=${partition}`;

    await page.goto(url);

    // A stalled QUnit run used to sit here until the test timeout with nothing
    // to show. Waiting on progress instead names the test that stopped moving.
    await page.waitForFunction(
      (stallMs) => {
        const w = window as any;

        return w.__argosDone === true || Date.now() - w.__argosProgressAt > stallMs;
      },
      STALL_TIMEOUT,
      { timeout: 29 * 60 * 1000 },
    );

    const done = await page.evaluate(() => (window as any).__argosDone === true);

    if (!done) {
      const current = await page.evaluate(() => (window as any).__argosCurrent);

      throw new Error(`partition ${partition} stopped making progress on: ${current}`);
    }

    const result = (await page.evaluate(() => (window as any).__argosResult)) as {
      failed: number;
      passed: number;
      total: number;
    };

    fs.mkdirSync(path.join(ROOT, 'argos', 'reports'), { recursive: true });
    fs.writeFileSync(
      path.join(ROOT, 'argos', 'reports', `partition-${partition}.json`),
      JSON.stringify({ result, captured, failures }, null, 2),
    );

    console.log(
      `partition ${partition}: ${captured.length} snapshots, qunit ${result.passed}/${result.total} passed`,
    );

    expect(failures, `screenshot failures:\n${failures.join('\n')}`).toEqual([]);
    expect(captured.length, 'no snapshot was captured in this partition').toBeGreaterThan(0);
  });
}
