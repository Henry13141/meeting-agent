import { createHash } from 'node:crypto';

export type RuntimeIdentity = Readonly<{
  kind: 'local_profile' | 'authenticated';
  namespace: string;
}>;

export const LOCAL_RUNTIME_IDENTITY: RuntimeIdentity = Object.freeze({
  kind: 'local_profile',
  namespace: 'local-profile-v1',
});

export function authenticatedRuntimeIdentity(opaqueSubject: string): RuntimeIdentity {
  if (
    opaqueSubject.length < 1
    || opaqueSubject.length > 255
    || opaqueSubject.trim() !== opaqueSubject
    || /\s/.test(opaqueSubject)
  ) throw new Error('RUNTIME_IDENTITY_SUBJECT_INVALID');
  const namespace = createHash('sha256')
    .update('meeting-agent-local-runtime:user-namespace:v1\0', 'utf8')
    .update(opaqueSubject, 'utf8')
    .digest('hex');
  return Object.freeze({ kind: 'authenticated', namespace: `user-${namespace}` });
}
