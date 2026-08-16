import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, useToast } from './Toast';

function Harness() {
  const toast = useToast();
  return (
    <div>
      <button type="button" onClick={() => toast.error('Deposit failed', 'You have no MON.')}>
        fail
      </button>
      <button type="button" onClick={() => toast.success('Deposit complete')}>
        win
      </button>
      <button type="button" onClick={() => toast.info('Settling…')}>
        note
      </button>
    </div>
  );
}

const renderHarness = () =>
  render(
    <ToastProvider>
      <Harness />
    </ToastProvider>,
  );

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => vi.useRealTimers());

describe('Toast', () => {
  it('shows an error with its detail (positive)', async () => {
    renderHarness();
    await userEvent.click(screen.getByRole('button', { name: 'fail' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Deposit failed');
    expect(alert).toHaveTextContent('You have no MON.');
  });

  it('uses alert for errors and status for the rest (a11y)', async () => {
    renderHarness();
    await userEvent.click(screen.getByRole('button', { name: 'win' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Deposit complete');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('never auto-dismisses an error (REGRESSION)', async () => {
    // A failed deposit is the answer to "what happened to my money". It has to
    // still be there when the user looks back at the tab.
    renderHarness();
    await userEvent.click(screen.getByRole('button', { name: 'fail' }));
    await screen.findByRole('alert');

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('auto-dismisses a success (positive)', async () => {
    renderHarness();
    await userEvent.click(screen.getByRole('button', { name: 'win' }));
    await screen.findByRole('status');

    await act(async () => {
      vi.advanceTimersByTime(6_500);
    });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('dismisses on demand (positive)', async () => {
    renderHarness();
    await userEvent.click(screen.getByRole('button', { name: 'fail' }));
    await screen.findByRole('alert');

    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('collapses repeats of the same message (negative)', async () => {
    // A user hammering a failing button should not bury the screen in copies of
    // one sentence.
    renderHarness();
    await userEvent.click(screen.getByRole('button', { name: 'fail' }));
    await userEvent.click(screen.getByRole('button', { name: 'fail' }));
    await userEvent.click(screen.getByRole('button', { name: 'fail' }));

    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('keeps distinct messages side by side (positive)', async () => {
    renderHarness();
    await userEvent.click(screen.getByRole('button', { name: 'fail' }));
    await userEvent.click(screen.getByRole('button', { name: 'note' }));

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders nothing at all when idle (negative)', () => {
    renderHarness();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('throws a useful error outside its provider (negative)', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Harness />)).toThrow(/within a ToastProvider/);
    quiet.mockRestore();
  });
});
