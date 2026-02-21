const THEME_KEY = 'app-theme';
const DEFAULT_THEME = 'valentine';
const THEMES = ['valentine', 'study'];

const getSavedTheme = () => {
  const savedTheme = localStorage.getItem(THEME_KEY);
  return THEMES.includes(savedTheme) ? savedTheme : DEFAULT_THEME;
};

const applyTheme = (themeName) => {
  const theme = THEMES.includes(themeName) ? themeName : DEFAULT_THEME;
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(THEME_KEY, theme);

  const label = document.getElementById('theme-current-label');
  if (label) {
    label.textContent = theme === 'valentine' ? 'Valentine' : 'Study';
  }

  const toggle = document.getElementById('theme-toggle');
  if (toggle) {
    toggle.setAttribute('aria-pressed', String(theme === 'study'));
  }
};

const toggleTheme = () => {
  const active = document.documentElement.getAttribute('data-theme') || DEFAULT_THEME;
  applyTheme(active === 'valentine' ? 'study' : 'valentine');
};

document.addEventListener('DOMContentLoaded', () => {
  applyTheme(getSavedTheme());

  const toggle = document.getElementById('theme-toggle');
  if (!toggle) {
    return;
  }

  toggle.addEventListener('click', toggleTheme);
});
