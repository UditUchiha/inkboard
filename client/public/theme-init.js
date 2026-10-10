// Applies the saved theme before the first paint to avoid a flash of the
// wrong colors. Kept as a file (not inline) so a strict CSP can allow it.
(function () {
  try {
    // With site data blocked, reading localStorage throws; the system theme still applies then,
    // as it does in the app (ThemeProvider), so there is no flash from light to dark.
    var saved = null;
    try {
      saved = localStorage.getItem("inkboard.theme");
    } catch (error) {
      saved = null;
    }
    var prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    var theme = saved === "light" || saved === "dark" ? saved : prefersDark ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    // Match the browser's own color (address bar, status bar) to the chosen theme, not just the system's.
    var tags = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < tags.length; i++) {
      tags[i].removeAttribute("media");
      tags[i].setAttribute("content", theme === "dark" ? "#121b2e" : "#f3f6f4");
    }
  } catch (error) {
    document.documentElement.dataset.theme = "light";
  }
})();
