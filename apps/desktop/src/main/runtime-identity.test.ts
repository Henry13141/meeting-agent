import { describe, expect, it } from 'vitest';

import {
  LOCAL_RUNTIME_IDENTITY,
  authenticatedRuntimeIdentity,
} from './runtime-identity';

describe('runtime identity namespace', () => {
  it('keeps the compatibility local profile explicit', () => {
    expect(LOCAL_RUNTIME_IDENTITY).toEqual({
      kind: 'local_profile',
      namespace: 'local-profile-v1',
    });
  });

  it('derives stable, distinct namespaces without exposing the subject', () => {
    const first = authenticatedRuntimeIdentity('cloud-user-01');
    const repeated = authenticatedRuntimeIdentity('cloud-user-01');
    const second = authenticatedRuntimeIdentity('cloud-user-02');

    expect(first).toEqual(repeated);
    expect(first.namespace).toMatch(/^user-[a-f0-9]{64}$/);
    expect(first.namespace).not.toContain('cloud-user-01');
    expect(second.namespace).not.toBe(first.namespace);
  });

  it('rejects blank, padded, or whitespace-bearing subjects', () => {
    for (const subject of ['', ' user', 'user ', 'user name']) {
      expect(() => authenticatedRuntimeIdentity(subject)).toThrow(
        'RUNTIME_IDENTITY_SUBJECT_INVALID',
      );
    }
  });
});
