export interface LifecycleGuard {
  padId: number;
  revision: number;
  generation: number;
  title: string;
  body: string;
  conflicted: boolean;
}

export function sameLifecycleTarget(captured: LifecycleGuard, current: LifecycleGuard | null): boolean {
  return current !== null && current.padId === captured.padId && current.generation === captured.generation;
}

export function sameLifecycleState(captured: LifecycleGuard, current: LifecycleGuard | null): boolean {
  if (!current || !sameLifecycleTarget(captured, current)) return false;
  return (
    current.revision === captured.revision &&
    current.title === captured.title &&
    current.body === captured.body &&
    current.conflicted === captured.conflicted
  );
}

export function canApplyLifecycleResult(captured: LifecycleGuard, current: LifecycleGuard | null): boolean {
  return sameLifecycleState(captured, current) && !current?.conflicted;
}
