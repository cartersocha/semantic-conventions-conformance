// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { load } from "../assets/data.js";
import view, { distinctFindings, libraries } from "../assets/views/overview.js";
import { report, target } from "./fixtures.js";
import { setup } from "./harness.js";

const tally = (emitted, declared) => ({ emitted, declared });
const run = (overrides) =>
  target({
    summary: {
      required: tally(1, 1),
      recommended: tally(1, 1),
      findings: 0,
    },
    ...overrides,
  });

function document() {
  return report([
    run({
      id: "database/java/mariadb/jdbc/opentelemetry-javaagent",
      backend: "mariadb",
      summary: {
        required: tally(2, 2),
        recommended: tally(1, 2),
        findings: 3,
      },
      findings: [
        // Repeated per signal, so counted once.
        ...Array.from({ length: 3 }, () => ({
          id: "type_mismatch",
          message: "Wrong type",
          context: { attribute_key: "db.system" },
        })),
      ],
    }),
    run({
      id: "database/java/postgresql/jdbc/opentelemetry-javaagent",
      backend: "postgresql",
      summary: {
        required: tally(1, 2),
        recommended: tally(2, 2),
        findings: 1,
      },
      findings: [{ id: "deprecated", message: "Old name" }],
    }),
    run({
      id: "http/python/flask/opentelemetry-instrumentation-flask",
      domain: "http",
      language: "python",
      instrumented_library: "flask",
      label: "opentelemetry-instrumentation-flask",
      backend: null,
      summary: {
        required: tally(3, 3),
        recommended: tally(3, 3),
        findings: 0,
      },
    }),
    run({
      id: "http/python/aiohttp/unscored",
      domain: "http",
      language: "python",
      instrumented_library: "aiohttp",
      label: "unscored",
      backend: null,
      summary: {
        required: tally(0, 0),
        recommended: tally(0, 0),
        findings: 0,
      },
    }),
  ]);
}

test("libraries pool their instrumentations' tallies", () => {
  const grouped = libraries(document().targets);
  const jdbc = grouped.find((library) => library.library === "jdbc");
  assert.equal(jdbc.rows.length, 2);
  assert.deepEqual(jdbc.required, tally(3, 4));
  assert.deepEqual(jdbc.recommended, tally(3, 4));
  assert.equal(jdbc.findings, 2);
  assert.equal(jdbc.meets, 1);
  // The run that meets every required attribute is listed first.
  assert.equal(jdbc.rows[0].target.backend, "mariadb");
});

test("findings are counted once per rule and attribute", () => {
  assert.equal(
    distinctFindings(
      run({
        findings: [
          { id: "a", message: "x", context: { attribute_key: "k" } },
          { id: "a", message: "y", context: { attribute_key: "k" } },
          { id: "a", message: "z" },
          { id: "b", message: "z" },
        ],
      }),
    ),
    3,
  );
});

test("the overview sorts, filters and remembers both in the link", async (t) => {
  const window = await setup(t, document(), "#/overview");
  const main = window.document.querySelector("main");
  main.replaceChildren(view(await load(), null, new URLSearchParams()));
  const names = () =>
    [...main.querySelectorAll("tr.lib-row .lib-name > :first-child")].map(
      (node) => node.textContent,
    );

  // Best required coverage first; an unscored library sorts last.
  assert.deepEqual(names(), ["flask", "jdbc", "aiohttp"]);
  assert.equal(main.querySelector(".count").textContent, "3 libraries");

  const sortBy = (label) =>
    [...main.querySelectorAll("th button.sort")]
      .find((button) => button.textContent.startsWith(label))
      .click();
  sortBy("Library");
  assert.deepEqual(names(), ["aiohttp", "flask", "jdbc"]);
  assert.equal(window.location.hash, "#/overview?sort=library");
  sortBy("Library");
  assert.deepEqual(names(), ["jdbc", "flask", "aiohttp"]);
  assert.equal(window.location.hash, "#/overview?sort=library&dir=desc");
  assert.equal(
    main.querySelector('th[data-sort="library"]').getAttribute("aria-sort"),
    "descending",
  );

  const search = main.querySelector("input.search");
  search.value = "postgres";
  search.dispatchEvent(new window.Event("input"));
  assert.deepEqual(names(), ["jdbc"]);
  assert.equal(main.querySelector(".count").textContent, "1 of 3 libraries");
  assert.match(
    window.location.hash,
    /^#\/overview\?q=postgres&sort=library&dir=desc$/,
  );

  // A library with several instrumentations expands into one row each.
  const toggle = main.querySelector("tr.lib-row .row-toggle");
  const subRows = () =>
    [...main.querySelectorAll("tr.sub-row")].filter((row) => !row.hidden);
  assert.equal(subRows().length, 0);
  toggle.click();
  assert.equal(subRows().length, 2);
  assert.equal(
    subRows()[0].querySelector("a").getAttribute("href"),
    "#/target/database/java/mariadb/jdbc/opentelemetry-javaagent",
  );
  // A missed required attribute makes that run's findings stand out.
  assert.ok(subRows()[1].querySelector(".count-badge.hot"));
  assert.equal(subRows()[0].querySelector(".count-badge.hot"), null);
});

test("an overview link restores its filters and ignores unknown values", async (t) => {
  const window = await setup(t, document(), "#/overview");
  const main = window.document.querySelector("main");
  main.replaceChildren(
    view(
      await load(),
      null,
      new URLSearchParams("domain=http&lang=python,cobol&sort=bogus"),
    ),
  );
  assert.equal(main.querySelector(".count").textContent, "2 of 3 libraries");
  assert.equal(
    main.querySelector('th[data-sort="required"]').getAttribute("aria-sort"),
    "descending",
  );
  // A filter bar without dropdowns must not leave a stray `0` behind.
  const strays = [".filterbar", ".filterbar-row"].flatMap((selector) =>
    [...main.querySelector(selector).childNodes].filter(
      (node) => node.nodeType === window.Node.TEXT_NODE,
    ),
  );
  assert.deepEqual(strays, []);
});
