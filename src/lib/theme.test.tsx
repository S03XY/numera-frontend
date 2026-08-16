import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider, THEME_SCRIPT, useTheme } from './theme';
import { ThemeToggle } from '@/components/ui/ThemeToggle';

function Readout() {
  const { theme } = useTheme();
  return <span data-testid="theme">{theme}</span>;
}

function mount() {
  return render(
    <ThemeProvider>
      <Readout />
      <ThemeToggle />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('theme', () => {
  it('defaults to dark when nothing is stored (positive)', () => {
    mount();
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
  });

  it('adopts the theme the pre-paint script already put on <html>', () => {
    document.documentElement.setAttribute('data-theme', 'light');
    mount();
    expect(screen.getByTestId('theme')).toHaveTextContent('light');
  });

  it('toggles both the attribute and the stored preference', async () => {
    mount();
    await userEvent.click(screen.getByRole('button', { name: /switch to light theme/i }));

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('numera.theme')).toBe('light');
    expect(screen.getByTestId('theme')).toHaveTextContent('light');
  });

  it('toggles back to dark', async () => {
    mount();
    const toggle = screen.getByRole('button', { name: /switch to/i });
    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole('button', { name: /switch to dark theme/i }));

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('numera.theme')).toBe('dark');
    expect(toggle).toBeInTheDocument();
  });

  it('ignores a corrupt stored value rather than rendering an unstyled page (negative)', () => {
    localStorage.setItem('numera.theme', 'chartreuse');
    document.documentElement.setAttribute('data-theme', 'chartreuse');
    mount();
    // Anything that is not "light" resolves to the dark default.
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
  });

  it('throws outside a provider rather than silently rendering the wrong theme (negative)', () => {
    expect(() => render(<Readout />)).toThrow(/ThemeProvider/);
  });
});

describe('THEME_SCRIPT', () => {
  it('reads the stored preference and falls back to the OS setting', () => {
    expect(THEME_SCRIPT).toContain('numera.theme');
    expect(THEME_SCRIPT).toContain('prefers-color-scheme: light');
    expect(THEME_SCRIPT).toContain('data-theme');
  });

  it('applies a theme even when storage throws (negative)', () => {
    // Private browsing can make localStorage.getItem throw; the catch keeps the
    // page from rendering with no theme at all.
    expect(THEME_SCRIPT).toMatch(/catch\(e\)\{document\.documentElement\.setAttribute\('data-theme','dark'\)/);
  });

  it('runs standalone without throwing', () => {
    expect(() => new Function(THEME_SCRIPT)()).not.toThrow();
    expect(document.documentElement.getAttribute('data-theme')).toMatch(/dark|light/);
  });
});
