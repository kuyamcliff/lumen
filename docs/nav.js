/**
 * Shared docs navigation.
 *
 * Kept as one script rather than duplicated markup so adding a page means
 * editing one list, and so the "current page" highlight can't drift out of
 * sync between pages.
 */
const PAGES = [
  {
    group: "Getting started",
    links: [
      ["index.html", "Introduction"],
      ["install.html", "Installation"],
      ["formats.html", "Format support"],
    ],
  },
  {
    group: "Guides",
    links: [
      ["streaming.html", "HLS &amp; DASH"],
      ["subtitles.html", "Subtitles &amp; chapters"],
      ["playlists.html", "Playlists"],
      ["theming.html", "Theming"],
      ["i18n.html", "Translation"],
      ["drm.html", "DRM"],
      ["ads.html", "Ads"],
      ["offline.html", "Offline &amp; PWA"],
      ["frameworks.html", "React, Vue, Svelte"],
    ],
  },
  {
    group: "Reference",
    links: [
      ["api.html", "API reference"],
      ["events.html", "Events"],
      ["plugins.html", "Plugins"],
    ],
  },
];

export function renderNav() {
  const current = location.pathname.split("/").pop() || "index.html";

  const groups = PAGES.map(
    (section) => `
      <div class="nav-group">
        <h3>${section.group}</h3>
        ${section.links
          .map(
            ([href, label]) =>
              `<a href="${href}"${href === current ? ' class="active"' : ""}>${label}</a>`,
          )
          .join("")}
      </div>`,
  ).join("");

  document.querySelector(".sidebar").innerHTML = `
    <p class="brand">Lu<span>men</span></p>
    <p class="tagline">Beautiful · Simple · Unbreakable</p>
    ${groups}
    <div class="nav-group">
      <h3>Project</h3>
      <a href="../examples/index.html">Live examples</a>
      <a href="https://github.com/kuyamcliff/lumen">GitHub</a>
    </div>`;
}

renderNav();
