type MeetingCloseOperations = {
  waitForStart(): Promise<void>;
  cancelRuns: readonly (() => Promise<void>)[];
  stopRecording(): Promise<void>;
  programWrites: ReadonlySet<Promise<void>>;
};

/** Resolve only after capture (including ASR/archive queues) and writes drain. */
export async function drainMeetingBeforeClose(operations: MeetingCloseOperations): Promise<void> {
  // Model cancellation may fail; it must never prevent saving captured audio.
  const cancellations = Promise.allSettled(operations.cancelRuns.map(cancel => Promise.resolve().then(cancel)));
  await operations.waitForStart();
  await operations.stopRecording();
  // A recorder callback may have added program writes while stop was draining.
  while (operations.programWrites.size) await Promise.allSettled([...operations.programWrites]);
  await cancellations;
}
