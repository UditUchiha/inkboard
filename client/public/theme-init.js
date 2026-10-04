// Applies the saved theme before the first paint to avoid a flash of the
// wrong colors. Kept as a file (not inline) so a strict CSP can allow it.
(function () {
  try {
    var saved = localStorage.getItem("inkboard.theme");
    var prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    var theme = saved === "light" || saved === "dark" ? saved : prefersDark ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
  } catch (error) {
    document.documentElement.dataset.theme = "light";
  }
})();
