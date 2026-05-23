export function computeDisableStdin(controlledBy: 'coordinator' | 'human' | undefined): boolean {
  return controlledBy === 'coordinator';
}
