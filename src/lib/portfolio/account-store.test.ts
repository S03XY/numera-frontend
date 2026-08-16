import { beforeEach, describe, expect, it } from 'vitest';
import {
  addExecutionAccount,
  clearExecutionAccounts,
  getExecutionAccounts,
  removeExecutionAccount,
} from './account-store';

const A = '0xAAAA111111111111111111111111111111111111';
const B = '0xbbbb222222222222222222222222222222222222';

beforeEach(() => clearExecutionAccounts());

describe('execution account store', () => {
  it('starts empty and adds accounts normalized to lowercase (positive)', () => {
    expect(getExecutionAccounts()).toEqual([]);
    addExecutionAccount(A);
    expect(getExecutionAccounts()).toEqual([A.toLowerCase()]);
  });

  it('is idempotent regardless of casing (regression — no duplicate accounts)', () => {
    addExecutionAccount(A);
    addExecutionAccount(A.toLowerCase());
    addExecutionAccount(A.toUpperCase().replace('0X', '0x'));
    expect(getExecutionAccounts()).toHaveLength(1);
  });

  it('tracks multiple accounts and removes one', () => {
    addExecutionAccount(A);
    addExecutionAccount(B);
    expect(getExecutionAccounts()).toHaveLength(2);
    removeExecutionAccount(A);
    expect(getExecutionAccounts()).toEqual([B]);
  });

  it('rejects malformed addresses (negative)', () => {
    addExecutionAccount('0x123');
    addExecutionAccount('not-an-address');
    addExecutionAccount('');
    expect(getExecutionAccounts()).toEqual([]);
  });

  it('survives corrupted storage without throwing (negative)', () => {
    window.localStorage.setItem('numera.executionAccounts', '{not json');
    expect(getExecutionAccounts()).toEqual([]);
  });

  it('filters out non-address entries injected into storage (negative)', () => {
    window.localStorage.setItem(
      'numera.executionAccounts',
      JSON.stringify([A.toLowerCase(), 'garbage', 42, null]),
    );
    expect(getExecutionAccounts()).toEqual([A.toLowerCase()]);
  });

  it('clears everything', () => {
    addExecutionAccount(A);
    clearExecutionAccounts();
    expect(getExecutionAccounts()).toEqual([]);
  });
});
