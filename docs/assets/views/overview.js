// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

// One row per instrumented library, so adherence can be compared at a glance
// before drilling into a signal or a single instrumentation.

import { fullLabel, languageColor, ratio } from "../data.js";
import { coverageBar, el, filterBar, trackBand } from "../ui.js";
import { setParams, targetHref } from "../route.js";

/**
 * Sortable columns. `best` is the direction that puts the most conformant
 * library first, which is what a first click on a score column shows.
 */
const SORTS = {
  library: { label: "Library", best: "asc" },
  required: { label: "Required", best: "desc" },
  recommended: { label: "Recommended", best: "desc" },
  findings: { label: "Findings", best: "asc" },
};
const DEFAULT_SORT = "required";
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const percent = (value) =>
  value === null ? "n/a" : `${Math.round(value * 100)}%`;

let stopTrackingBand = null;

export function dispose() {
  stopTrackingBand?.();
  stopTrackingBand = null;
}

export const title = () => "overview · conformance";

/**
 * Weaver repeats a finding per signal and per span, so a raw count mostly
 * measures how much was emitted. Counted the way the instrumentation page
 * groups them: once per rule and attribute, or rule and message.
 *
 * @param {import('../data.js').Target} target
 * @returns {number}
 */
export function distinctFindings(target) {
  const keys = new Set(
    (target.findings ?? []).map((finding) => {
      const attribute =
        finding.context?.attribute_key ??
        finding.context?.missing_attribute ??
        finding.message;
      return `${finding.id}\u0000${attribute}`;
    }),
  );
  return keys.size;
}

const sum = (tallies) =>
  tallies.reduce(
    (total, tally) => ({
      emitted: total.emitted + (tally?.emitted ?? 0),
      declared: total.declared + (tally?.declared ?? 0),
    }),
    { emitted: 0, declared: 0 },
  );

/** Whether a run emitted every attribute its signals declare as required. */
const meetsRequired = (target) =>
  target.summary.required.declared > 0 &&
  target.summary.required.emitted === target.summary.required.declared;
/** Whether a scored run left a required attribute out. */
const missesRequired = (target) =>
  target.summary.required.emitted < target.summary.required.declared;

/**
 * Group the report's targets by the library they instrument. A library is
 * named within its domain and language: `openai` in Python and in JS are
 * different instrumentation ecosystems.
 *
 * @param {import('../data.js').Target[]} targets
 */
export function libraries(targets) {
  const groups = Map.groupBy(
    targets,
    (target) =>
      `${target.domain}\u0000${target.language}\u0000${target.instrumented_library}`,
  );
  return [...groups.values()].map((members) => {
    const [first] = members;
    const rows = members
      .map((target) => ({
        target,
        required: target.summary.required,
        recommended: target.summary.recommended,
        findings: distinctFindings(target),
      }))
      .sort(
        (a, b) =>
          (ratio(b.required) ?? -1) - (ratio(a.required) ?? -1) ||
          (ratio(b.recommended) ?? -1) - (ratio(a.recommended) ?? -1) ||
          fullLabel(a.target).localeCompare(fullLabel(b.target)),
      );
    return {
      key: `${first.domain}/${first.language}/${first.instrumented_library}`,
      library: first.instrumented_library,
      domain: first.domain,
      language: first.language,
      rows,
      required: sum(rows.map((row) => row.required)),
      recommended: sum(rows.map((row) => row.recommended)),
      findings: rows.reduce((total, row) => total + row.findings, 0),
      meets: members.filter(meetsRequired).length,
    };
  });
}

function compare(sort, dir) {
  const flip = dir === "asc" ? 1 : -1;
  // Missing scores sort last whichever way the column runs.
  const score = (value) =>
    value === null ? (dir === "asc" ? Infinity : -Infinity) : value;
  const byName = (a, b) =>
    a.library.localeCompare(b.library) || a.language.localeCompare(b.language);
  const other = sort === "required" ? "recommended" : "required";
  return (a, b) => {
    let order;
    if (sort === "library") order = flip * byName(a, b);
    else if (sort === "findings") order = flip * (a.findings - b.findings);
    else
      order =
        flip * (score(ratio(a[sort])) - score(ratio(b[sort]))) ||
        // Ties on one level are broken by the other, best first.
        (ratio(b[other]) ?? -1) - (ratio(a[other]) ?? -1);
    return order || byName(a, b);
  };
}

function restore(params) {
  const read = (key) => params?.get(key) ?? "";
  const languages = read("lang");
  const sort = Object.hasOwn(SORTS, read("sort")) ? read("sort") : DEFAULT_SORT;
  const dir = ["asc", "desc"].includes(read("dir"))
    ? read("dir")
    : SORTS[sort].best;
  return {
    filters: {
      q: read("q"),
      languages: languages ? languages.split(",").filter(Boolean) : [],
      domain: read("domain"),
    },
    sort,
    dir,
  };
}

/**
 * Render the per-library overview.
 *
 * @param {import('../data.js').Data} data the indexed report
 * @param {string|null} _argument unused; the route takes no argument
 * @param {URLSearchParams} [params] filter and sort state from the link
 * @returns {HTMLElement}
 */
export default function overview(data, _argument, params) {
  dispose();
  const all = libraries(data.targets);
  if (!all.length) {
    return el("p", { class: "empty", text: "No targets in the report." });
  }
  const saved = restore(params);
  let { sort, dir } = saved;
  let filters = null;

  const summary = el("section", {
    class: "tiles overview-tiles",
    "aria-label": "Totals",
  });
  const table = el("div", { class: "table-wrap" });

  const remember = () =>
    setParams({
      q: filters.q,
      lang: filters.languages.join(","),
      domain: filters.domain,
      sort: sort === DEFAULT_SORT ? "" : sort,
      dir: dir === SORTS[sort].best ? "" : dir,
    });

  const matches = (library) => {
    if (
      filters.languages.length &&
      !filters.languages.includes(library.language)
    )
      return false;
    if (filters.domain && library.domain !== filters.domain) return false;
    if (filters.q) {
      const haystack = [
        library.library,
        library.language,
        library.domain,
        ...library.rows.flatMap(({ target }) => [
          target.label,
          target.instrumentation_library,
          target.backend ?? "",
        ]),
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(filters.q)) return false;
    }
    return true;
  };

  const draw = () => {
    const shown = all.filter(matches).sort(compare(sort, dir));
    summary.replaceChildren(...tiles(shown));
    table.replaceChildren(
      shown.length
        ? libraryTable(shown, sort, dir, (next) => {
            if (next === sort) dir = dir === "asc" ? "desc" : "asc";
            else {
              sort = next;
              dir = SORTS[next].best;
            }
            remember();
            draw();
            table.querySelector(`th[data-sort="${next}"] button`)?.focus();
          })
        : el("p", {
            class: "empty",
            text: "No libraries match those filters.",
          }),
    );
    const noun = all.length === 1 ? "library" : "libraries";
    return shown.length === all.length
      ? `${all.length} ${noun}`
      : `${shown.length} of ${all.length} ${noun}`;
  };

  const facet = (pick) => [...new Set(data.targets.map(pick))].sort();
  const bar = filterBar({
    search: "Filter by library, distribution or package…",
    pills: [
      {
        key: "languages",
        label: "Language",
        options: facet((target) => target.language).map((language) => ({
          value: language,
          label: language,
          count: all.filter((library) => library.language === language).length,
          color: languageColor(language),
        })),
      },
    ],
    segments: [
      {
        key: "domain",
        label: "Domain",
        options: [
          { value: "", label: "All domains" },
          ...facet((target) => target.domain).map((domain) => ({
            value: domain,
            label: domain,
          })),
        ],
      },
    ],
    state: saved.filters,
    onChange: (state) => {
      filters = state;
      remember();
      return draw();
    },
  });

  const controls = el("div", { class: "controls" }, [
    el("div", { class: "controls-row" }, [el("h2", { text: "Overview" })]),
    bar.node,
  ]);
  stopTrackingBand = trackBand(controls);

  return el("div", { class: "overview" }, [
    controls,
    el("p", {
      class: "tagline",
      text: "How closely each instrumented library follows the semantic conventions, across every instrumentation of it that was measured.",
    }),
    el("details", { class: "lede" }, [
      el("summary", {
        text: "Scores are attributes emitted out of those declared, summed over the library's instrumentations.",
      }),
      el("p", {
        text:
          "Required counts required and conditionally required attributes on " +
          "the signals a run emitted; conditional ones may be legitimately " +
          "absent for a scenario. Findings are distinct Weaver rules broken or " +
          "absences reported, counted once per rule and attribute rather than " +
          "per occurrence. Expand a library to compare its instrumentations, " +
          "or open one for what to fix.",
      }),
    ]),
    summary,
    table,
  ]);
}

function tiles(shown) {
  const targets = shown.flatMap((library) => library.rows);
  const required = sum(targets.map((row) => row.required));
  const recommended = sum(targets.map((row) => row.recommended));
  const scored = targets.filter((row) => row.required.declared > 0).length;
  const meets = shown.reduce((total, library) => total + library.meets, 0);
  const tile = (label, big, small, extra) =>
    el("div", { class: "tile" }, [
      el("span", { class: "tile-label", text: label }),
      el("span", { class: "tile-big" }, [
        big,
        small && el("small", { text: ` ${small}` }),
      ]),
      extra,
    ]);
  return [
    tile(
      "Libraries",
      String(shown.length),
      `${plural(targets.length, "instrumentation")}`,
    ),
    tile(
      "Meet every required attribute",
      String(meets),
      `of ${plural(scored, "instrumentation")}`,
      coverageBar({ emitted: meets, declared: scored }, "instrumentations"),
    ),
    tile(
      "Required attributes",
      percent(ratio(required)),
      required.declared ? `${required.emitted} of ${required.declared}` : "",
      coverageBar(required, "required"),
    ),
    tile(
      "Recommended attributes",
      percent(ratio(recommended)),
      recommended.declared
        ? `${recommended.emitted} of ${recommended.declared}`
        : "",
      coverageBar(recommended, "recommended"),
    ),
  ];
}

function libraryTable(shown, sort, dir, onSort) {
  const head = (key, extra = {}) => {
    const active = key === sort;
    return el(
      "th",
      {
        "data-sort": key,
        "aria-sort": active
          ? dir === "asc"
            ? "ascending"
            : "descending"
          : null,
        ...extra,
      },
      [
        el("button", {
          type: "button",
          class: `sort${active ? " active" : ""}`,
          text: `${SORTS[key].label}${active ? (dir === "asc" ? " ↑" : " ↓") : ""}`,
          onclick: () => onSort(key),
        }),
      ],
    );
  };
  return el("table", { class: "overview-table" }, [
    el("thead", {}, [
      el("tr", {}, [
        head("library"),
        el("th", { text: "Language" }),
        el("th", { text: "Domain" }),
        head("required"),
        head("recommended"),
        head("findings", { class: "num" }),
      ]),
    ]),
    ...shown.map(libraryRows),
  ]);
}

/** A library's row, and when it has several instrumentations, one per run. */
function libraryRows(library) {
  const single = library.rows.length === 1;
  const subRows = single
    ? []
    : library.rows.map((row) =>
        el("tr", { class: "sub-row", hidden: true }, [
          el("td", { colspan: 3 }, [
            el("a", {
              href: targetHref(row.target.id),
              text: runName(row.target, true),
              title: fullLabel(row.target),
            }),
          ]),
          el("td", {}, coverageBar(row.required, "required")),
          el("td", {}, coverageBar(row.recommended, "recommended")),
          el(
            "td",
            { class: "num" },
            findingsBadge(row.findings, missesRequired(row.target)),
          ),
        ]),
      );
  const name = single
    ? el("div", { class: "lib-name" }, [
        el("a", {
          class: "mono",
          href: targetHref(library.rows[0].target.id),
          text: library.library,
        }),
        el("small", {
          text: runName(library.rows[0].target, false),
        }),
      ])
    : el("div", { class: "lib-name" }, [
        el("button", {
          type: "button",
          class: "row-toggle mono",
          "aria-expanded": "false",
          text: library.library,
          onclick: (event) => {
            const open =
              event.currentTarget.getAttribute("aria-expanded") !== "true";
            event.currentTarget.setAttribute("aria-expanded", String(open));
            for (const row of subRows) row.hidden = !open;
          },
        }),
        el("small", {
          text: `${plural(library.rows.length, "instrumentation")} · ${library.meets} meet required`,
        }),
      ]);
  return el("tbody", { "data-library": library.key }, [
    el("tr", { class: "lib-row" }, [
      el("td", {}, name),
      el("td", {}, [
        el("span", { class: "lang" }, [
          el("i", {
            class: "dot",
            style: `background:${languageColor(library.language)}`,
          }),
          library.language,
        ]),
      ]),
      el("td", { class: "kind", text: library.domain }),
      el("td", {}, coverageBar(library.required, "required")),
      el("td", {}, coverageBar(library.recommended, "recommended")),
      el(
        "td",
        { class: "num" },
        findingsBadge(
          library.findings,
          library.rows.some((row) => missesRequired(row.target)),
        ),
      ),
    ]),
    ...subRows,
  ]);
}

/**
 * An instrumentation under its library's name: the backend when the library
 * does not already name it, the distribution, and the side when asked for.
 */
function runName(target, sided) {
  const library = target.instrumented_library;
  const backend =
    target.backend &&
    library !== target.backend &&
    !library.startsWith(`${target.backend}-`)
      ? target.backend
      : null;
  return [backend, target.label, sided && target.side]
    .filter(Boolean)
    .join(" · ");
}

/** Highlighted when a required attribute is also missing: the findings are
 *  then more than advice. */
function findingsBadge(count, hot) {
  if (!count) return el("span", { class: "ver", text: "—" });
  return el("span", {
    class: `count-badge${hot ? " hot" : ""}`,
    text: String(count),
  });
}
